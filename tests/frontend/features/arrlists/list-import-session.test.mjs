import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../../helpers/harness.mjs';

// The import client binds each WHOLE operation (one call, a URL read with its parental-pending retries, a resolve loop
// with every chunk, retry and sleep) to the session it started in: the user, the server, the session epoch and that user's token,
// read once. Every request of the operation carries that token, never the current one; the binding is checked again
// after every await (the answer's body included). Once the user, the epoch or the token moved on, the operation stops
// with {stale: true}: nothing more is sent, nothing it read is returned, and rows it had resolved are put back unresolved
// (review round 1, 4c2-B1 / 4C2-SEC-01).

const BASE = 'http://jellyfin.test/JellyfinEnhanced/acquire/lists/import';
const movie = (tmdbId, title) => ({ mediaType: 'movie', tmdbId, title, year: 2013, releaseDate: '2013-06-12', posterPath: `/p${tmdbId}.jpg`, overview: 'o', score: 160 });
const ok = (index, match) => ({ index, state: 'ok', confidence: 'high', kind: 'movie', match, candidates: [match], reasons: [], alternatives: false });

/**
 * Loads the import module with a session whose user, epoch and token tests change, and a fetch fixture: `routes` maps
 * "METHOD /path" to a handler returning {status, body, headers, text} (text: an async body reader replacing the JSON).
 */
function load(t, routes) {
  const state = { epoch: 1, user: 'user-a', server: 'server-a', token: 'token-a' };
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = { path: String(url).replace(BASE, ''), token: /Token="([^"]*)"/.exec(init.headers?.Authorization || '')?.[1], body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const handler = routes[`${init.method || 'GET'} ${call.path}`];
    if (!handler) throw new Error(`unexpected ${init.method || 'GET'} ${call.path}`);
    const { status = 200, body = null, headers = {}, text } = await handler(call.body, call);
    return { status, headers: { get: name => headers[name] ?? null }, text: text || (async () => (body == null ? '' : JSON.stringify(body))) };
  };
  const h = createHarness({
    fetch,
    apiClient: { getCurrentUserId: () => state.user, serverId: () => state.server, accessToken: () => state.token },
    JE: { pluginConfig: { ArrListImportEnabled: true, ArrListSourcesEnabled: true }, session: { getEpoch: () => state.epoch }, t: key => key }
  });
  t.after(() => h.close());
  h.load('arr/lists/list-parser.js');
  h.load('arr/lists/list-import.js');
  /** Another person signs in: a new user, epoch and token. */
  const switchUser = () => { state.epoch++; state.user = 'user-b'; state.token = 'token-b'; };
  return { imp: h.JE.arrListImport, calls, state, switchUser };
}

const answer = body => ({ results: body.entries.map(e => ok(e.index, movie(1000 + e.index, e.title))), complete: true });
const rowsOf = (imp, n) => Array.from({ length: n }, (_, i) => imp.newRow({ title: `Title ${i}`, year: 2000 }, i, 'playlist'));

test('a switch while the answer\'s body is still being read is stale: the previous account\'s answer is never returned', async t => {
  const body = deferred();
  const { imp, switchUser } = load(t, {
    'POST /source': () => ({ text: () => body.promise })
  });
  const pending = imp.api.fetchSource('https://mdblist.com/lists/a/b');
  await new Promise(resolve => setTimeout(resolve, 0));
  switchUser();
  body.resolve(JSON.stringify({ kind: 'mdblist', entries: [{ title: 'secret of the previous user' }] }));
  await assert.rejects(() => pending, error => error.stale === true);
});

test('a new user without a new epoch yet (the session check is late) is stale too, and gets nothing sent with their token', async t => {
  const { imp, calls, state } = load(t, { 'GET /providers': () => ({ body: { maxItems: 1000 } }) });
  assert.equal((await imp.api.providers()).maxItems, 1000);
  assert.equal(calls[0].token, 'token-a');
  const pending = imp.resolveRows(rowsOf(imp, 30), { listKind: 'playlist' });
  // Same epoch, but ApiClient already holds another user and token: the operation's own token is stale.
  state.user = 'user-b';
  state.token = 'token-b';
  await assert.rejects(() => pending, error => error.stale === true);
  assert.deepEqual(calls.map(c => c.token), ['token-a', 'token-a']); // providers, then chunk 1 (sent before the change)
});

test('a resolve loop never sends a later chunk with the new account\'s token and keeps none of the earlier chunk\'s rows', async t => {
  let switchUser;
  const progress = [];
  const fixture = load(t, {
    'POST /resolve': (body, call) => {
      if (body.entries[0].index === 0) switchUser(); // the switch lands while chunk 1 is answered
      return { body: answer(body) };
    }
  });
  switchUser = fixture.switchUser;
  const rows = rowsOf(fixture.imp, 30);

  await assert.rejects(() => fixture.imp.resolveRows(rows, { listKind: 'playlist', onChunk: (chunk, done) => progress.push(done) }), error => error.stale === true);
  assert.deepEqual(fixture.calls.map(c => c.token), ['token-a']); // chunk 2 was never sent, with any token
  assert.deepEqual(progress, []);
  assert.ok(rows.every(r => r.result === null && r.cands.length === 0 && r.action === 'skip' && !r.failed && !r.transient));
});

test('a switch between chunks: the rows resolved for the previous account are put back unresolved', async t => {
  let switchUser;
  const progress = [];
  const fixture = load(t, { 'POST /resolve': body => ({ body: answer(body) }) });
  switchUser = fixture.switchUser;
  const rows = rowsOf(fixture.imp, 30);

  await assert.rejects(() => fixture.imp.resolveRows(rows, { listKind: 'playlist', onChunk: (chunk, done) => { progress.push(done); if (done === 25) switchUser(); } }), error => error.stale === true);
  assert.deepEqual(progress, [25]);
  assert.deepEqual(fixture.calls.map(c => c.token), ['token-a']);
  assert.ok(rows.every(r => r.result === null && r.cands.length === 0 && r.action === 'skip'), 'no row keeps the previous account\'s candidates');
});

test('a switch during a busy retry\'s wait sends nothing more and is stale', async t => {
  let switchUser;
  const fixture = load(t, {
    'POST /resolve': () => {
      setTimeout(() => switchUser(), 0); // during the Retry-After wait
      return { status: 429, body: { code: 'busy' }, headers: { 'Retry-After': '0.02' } };
    }
  });
  switchUser = fixture.switchUser;
  await assert.rejects(() => fixture.imp.resolveRows(rowsOf(fixture.imp, 3), { listKind: 'playlist' }), error => error.stale === true);
  assert.deepEqual(fixture.calls.map(c => c.token), ['token-a']);
});

test('a switch during a network-failure retry\'s wait is stale, not the network error', async t => {
  let switchUser;
  const fixture = load(t, {
    'POST /resolve': () => { switchUser(); throw new TypeError('Failed to fetch'); }
  });
  switchUser = fixture.switchUser;
  await assert.rejects(() => fixture.imp.resolveRows(rowsOf(fixture.imp, 2), { listKind: 'playlist' }), error => error.stale === true);
  assert.equal(fixture.calls.length, 1);
});

test('a URL read: a switch during the parental-pending wait never re-sends the previous account\'s URL with the new token', async t => {
  let switchUser;
  const fixture = load(t, {
    'POST /source': () => {
      setTimeout(() => switchUser(), 0);
      return { status: 504, body: { code: 'parental_pending' }, headers: { 'Retry-After': '0.02' } };
    }
  });
  switchUser = fixture.switchUser;
  await assert.rejects(() => fixture.imp.fetchWithRetry('https://mdblist.com/lists/private/x'), error => error.stale === true);
  assert.deepEqual(fixture.calls.map(c => [c.token, c.body.url]), [['token-a', 'https://mdblist.com/lists/private/x']]);
});

test('the same user\'s operation keeps its own token for every request, retries included, and completes', async t => {
  let calls = 0;
  const fixture = load(t, {
    'POST /source': () => (++calls === 1 ? { status: 504, body: { code: 'parental_pending' }, headers: { 'Retry-After': '0.001' } } : { body: { kind: 'mdblist', entries: [{ title: 'A' }] } }),
    'POST /resolve': body => ({ body: answer(body) })
  });
  const fetched = await fixture.imp.fetchWithRetry('https://mdblist.com/lists/a/b');
  assert.equal(fetched.entries.length, 1);
  const rows = await fixture.imp.resolveRows(rowsOf(fixture.imp, 30), { listKind: 'playlist' });
  assert.ok(rows.every(r => r.result));
  assert.deepEqual(fixture.calls.map(c => c.token), ['token-a', 'token-a', 'token-a', 'token-a']);
});

test('an operation started for a session that already ended sends nothing', async t => {
  const fixture = load(t, { 'POST /source': () => ({ body: { kind: 'mdblist', entries: [] } }) });
  const session = fixture.imp.bindSession();
  fixture.switchUser();
  await assert.rejects(() => fixture.imp.fetchWithRetry('https://mdblist.com/lists/a/b', { session }), error => error.stale === true);
  await assert.rejects(() => fixture.imp.api.resolve([{ index: 0, title: 'A' }], { session }), error => error.stale === true);
  assert.equal(fixture.calls.length, 0);
});

test('a server switch with the same user id (multi-server ApiClient) is stale: the next chunk is never sent to the other server', async t => {
  let fixture;
  fixture = load(t, {
    'POST /resolve': body => {
      if (body.entries[0].index === 0) fixture.state.server = 'server-b'; // same user id and token, another server
      return { body: answer(body) };
    }
  });
  const rows = rowsOf(fixture.imp, 30);
  await assert.rejects(() => fixture.imp.resolveRows(rows, { listKind: 'playlist' }), error => error.stale === true);
  assert.equal(fixture.calls.length, 1);
  assert.ok(rows.every(r => r.result === null));
});
