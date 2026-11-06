import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * The pipeline over a paging server: `total` movies with sorted ids, served `limit` at a time after `after`.
 * `change(page)` may alter the answer of a page (another generation, another filter). Deltas answer empty.
 * The stub store accepts the full write and records how many entries it was given.
 */
async function pagedHarness(t, { total, change = () => null, pages = true, storage = true, waitFor = null, commitGate = null } = {}) {
  const ids = Array.from({ length: total }, (_, i) => `m${String(i).padStart(6, '0')}`);
  const requests = [];
  const stored = { entries: 0, committed: false, began: 0 };
  // The signed-in account (core/session.js): its epoch moves on a switch, and the pipeline's reset runs.
  const session = { epoch: 0, user: 'user-a', onChange: [] };
  let fullRequests = 0;
  const h = createHarness({
    globals: { requestIdleCallback: cb => setTimeout(() => cb({ timeRemaining: () => 50, didTimeout: false }), 0) },
    apiClient: {
      getCurrentUserId: () => 'user-a',
      getUrl: (path, params) => `http://jellyfin.test${path}${params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`,
      ajax: async ({ url }) => {
        const query = new URL(url).searchParams;
        requests.push(Object.fromEntries(query));
        if (query.has('since')) return { items: {}, count: 0, version: 4, timestamp: Number(query.get('since')), filterRevision: 'r1', filterBase: 'b1', servedAt: 99 };
        const page = fullRequests++;
        const limit = pages && query.has('limit') ? Number(query.get('limit')) : Infinity;
        const after = query.get('after') || '';
        const rest = ids.filter(id => id > after);
        const slice = rest.slice(0, limit);
        const answer = { version: 4, timestamp: 50 + page, servedAt: 60 + page, filterRevision: 'r1', filterBase: 'b1', count: slice.length,
          items: Object.fromEntries(slice.map(id => [id, { Type: 'Movie', Genres: [id] }])), ...(rest.length > slice.length ? { next: slice.at(-1) } : {}) };
        return { ...answer, ...(change(page) || {}) };
      },
    },
    JE: {
      pluginConfig: { TagCacheServerMode: true }, currentSettings: { qualityTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
      session: { getUserId: () => session.user, getServerId: () => 'server-a', getEpoch: () => session.epoch, isCurrent: (epoch) => epoch === session.epoch,
        onUserChange(name, fn) { session.onChange.push(fn); } },
      tagCacheStore: {
        available: () => storage,
        getMeta: async () => null,
        getMany: async (scope, wanted) => ({ entries: new Map(wanted.filter(id => ids.includes(id)).map(id => [id, { Type: 'Movie', Genres: [id], stored: true }])), meta: stored.committed ? { version: 4, filterRevision: 'r1', servedAt: 60, count: stored.entries } : null }),
        clearScope: async () => {}, clearOtherScopes: async () => {},
        beginFullWrite: async () => { stored.began++; stored.entries = 0; stored.committed = false; return true; },
        putManyIfOwner: async (scope, token, entries) => { stored.entries += entries.length; return true; },
        commitFullWrite: async () => { if (commitGate) await commitGate; stored.committed = true; return true; },
        applyDelta: async () => true,
        reconcileAccess: async () => ({ applied: true, dropped: [] }),
      },
    },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.registerRenderer('probe', { render() {}, isEnabled: () => false });
  h.JE.tagPipeline.initialize();
  // The initial load: done once the last entry is in memory (or `waitFor` holds).
  const done = waitFor ? () => waitFor({ stored, requests }) : () => h.JE.tagPipeline.peekServerEntry(ids.at(-1));
  for (let i = 0; i < 2000 && !done(); i++) await (i < 400 ? settle() : new Promise(resolve => setTimeout(resolve, 10)));
  /** Sign another account in, as core/session.js reports it. */
  const switchUser = (user) => { session.epoch++; session.user = user; for (const fn of session.onChange) fn({ userId: user, serverId: 'server-a' }); };
  return { h, ids, requests, stored, pipeline: h.JE.tagPipeline, switchUser };
}

test('a full load reads the cache in bounded pages, then a delta since the first page catches up', async t => {
  const { ids, requests, pipeline } = await pagedHarness(t, { total: 4500 });
  const full = requests.filter(r => !('since' in r));
  assert.deepEqual(full.map(r => [r.limit, r.after || '']), [['2000', ''], ['2000', ids[1999]], ['2000', ids[3999]]]);
  assert.ok(full.every(r => r.fresh), 'every page bypasses HTTP revalidation');
  for (const id of [ids[0], ids[2000], ids[4499]]) assert.deepEqual(JSON.parse(JSON.stringify(pipeline.peekServerEntry(id))), { Type: 'Movie', Genres: [id] });
  for (let i = 0; i < 40 && !requests.some(r => 'since' in r); i++) await settle();
  assert.equal(requests.find(r => 'since' in r)?.since, '50', 'the delta starts at the first page, so changes made while paging arrive');
});

test('pages from another generation or filter start the load over; a load that keeps changing never asks for everything at once', async t => {
  // The second page of the first try comes from a rebuilt cache; the retry is clean.
  const once = await pagedHarness(t, { total: 2500, change: page => (page === 1 ? { version: 5 } : null) });
  const full = once.requests.filter(r => !('since' in r));
  assert.deepEqual(full.map(r => r.after || ''), ['', once.ids[1999], '', once.ids[1999]]);
  assert.ok(once.pipeline.peekServerEntry(once.ids[2499]));
  // Every try sees the filter change: three paged tries (with pauses), never one unlimited response, then the
  // cards use the batch route and nothing is held.
  const always = await pagedHarness(t, { total: 2500, change: page => (page % 2 === 1 ? { filterRevision: 'r2' } : null), waitFor: ({ requests }) => requests.length >= 6 });
  for (let i = 0; i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const tries = always.requests.filter(r => !('since' in r));
  assert.equal(tries.length, 6, 'three tries of two pages');
  assert.ok(tries.every(r => r.limit === '2000'), 'every request is a bounded page');
  assert.equal(always.pipeline.peekServerEntry(always.ids[0]), null);
});

test('a server that does not page answers in one response and needs no catch-up delta', async t => {
  const { requests, ids, pipeline } = await pagedHarness(t, { total: 300, pages: false });
  assert.equal(requests.filter(r => !('since' in r)).length, 1);
  assert.ok(pipeline.peekServerEntry(ids[299]));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(requests.filter(r => 'since' in r).length, 0);
});

test('a library past the memory cap streams into the stored copy as it loads; memory holds only what cards read', async t => {
  const { ids, stored, pipeline, requests } = await pagedHarness(t, { total: 24500, waitFor: ({ stored }) => stored.committed });
  assert.equal(stored.committed, true);
  assert.equal(stored.began, 1, 'one claimed rewrite');
  assert.equal(stored.entries, 24500, 'every entry written before the commit');
  assert.equal(pipeline.peekServerEntry(ids[0]), null, 'nothing past the cap stays in memory');
  assert.equal(pipeline.peekServerEntry(ids[24499]), null);
  const read = await pipeline.lookupServerEntries([ids[7], ids[24499]]);
  assert.equal(read.get(ids[24499])?.stored, true, 'read back from the stored copy');
  assert.equal(read.size, 2);
  for (let i = 0; i < 40 && !requests.some(r => 'since' in r); i++) await settle();
  assert.equal(requests.find(r => 'since' in r)?.since, '50', 'the catch-up delta still starts at the first page');
});

test('an account switch while a streamed load commits never hands the outgoing account\'s copy to the incoming one', async t => {
  let release;
  const commitGate = new Promise(resolve => { release = resolve; });
  const { ids, stored, pipeline, switchUser } = await pagedHarness(t, { total: 24500, commitGate, waitFor: ({ stored }) => stored.entries >= 24500 });
  assert.equal(stored.committed, false, 'the commit is still on its way');
  switchUser('user-b');
  release();
  for (let i = 0; i < 50; i++) await settle();
  assert.equal(stored.committed, true, 'the outgoing account\'s copy is committed in its own scope');
  assert.equal(pipeline.peekServerEntry(ids[0]), null);
  const read = await pipeline.lookupServerEntries([ids[0], ids[24499]]);
  assert.equal(read.size, 0, 'nothing of the outgoing account is read for the incoming one');
});

test('without a stored copy, a library past the memory cap is not held: cards ask per batch for the session', async t => {
  const { ids, pipeline, requests } = await pagedHarness(t, { total: 24500, storage: false, waitFor: ({ requests }) => requests.length >= 11 });
  for (let i = 0; i < 50; i++) await settle();
  const full = requests.filter(r => !('since' in r));
  assert.equal(full.length, 11, 'it stops at the first page past the cap (20,000 + one page)');
  assert.equal(pipeline.peekServerEntry(ids[0]), null, 'nothing is kept');
  // Navigation does not start the whole download again.
  await pipeline.waitForServerCache(() => true, { delays: [0] });
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(requests.filter(r => !('since' in r)).length, 11);
});
