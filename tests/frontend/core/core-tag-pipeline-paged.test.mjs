import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * The pipeline over a paging server: `total` movies with sorted ids, served `limit` at a time after `after`.
 * `change(page)` may alter the answer of a page (another generation, another filter). Deltas answer empty.
 * The stub store accepts the full write and records how many entries it was given.
 */
async function pagedHarness(t, { total, change = () => null, pages = true } = {}) {
  const ids = Array.from({ length: total }, (_, i) => `m${String(i).padStart(6, '0')}`);
  const requests = [];
  const stored = { entries: 0, committed: false };
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
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      tagCacheStore: {
        available: () => true,
        getMeta: async () => null,
        getMany: async (scope, wanted) => ({ entries: new Map(wanted.filter(id => ids.includes(id)).map(id => [id, { Type: 'Movie', Genres: [id], stored: true }])), meta: stored.committed ? { version: 4, filterRevision: 'r1', servedAt: 60, count: stored.entries } : null }),
        clearScope: async () => {}, clearOtherScopes: async () => {},
        beginFullWrite: async () => true,
        putManyIfOwner: async (scope, token, entries) => { stored.entries += entries.length; return true; },
        commitFullWrite: async () => { stored.committed = true; return true; },
        applyDelta: async () => true,
        reconcileAccess: async () => ({ applied: true, dropped: [] }),
      },
    },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.registerRenderer('probe', { render() {}, isEnabled: () => false });
  h.JE.tagPipeline.initialize();
  // The initial load: done once the last entry is in memory and no request is pending.
  for (let i = 0; i < 400; i++) {
    await settle();
    if (h.JE.tagPipeline.peekServerEntry(ids.at(-1))) break;
  }
  return { h, ids, requests, stored, pipeline: h.JE.tagPipeline };
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

test('pages from another generation or filter start the load over, and finally take one response', async t => {
  // The second page of the first try comes from a rebuilt cache; the retry is clean.
  const once = await pagedHarness(t, { total: 2500, change: page => (page === 1 ? { version: 5 } : null) });
  const full = once.requests.filter(r => !('since' in r));
  assert.deepEqual(full.map(r => r.after || ''), ['', once.ids[1999], '', once.ids[1999]]);
  assert.ok(once.pipeline.peekServerEntry(once.ids[2499]));
  // Every paged try sees the filter change: the last try asks without a limit, in one response.
  const always = await pagedHarness(t, { total: 2500, change: page => (page % 2 === 1 ? { filterRevision: 'r2' } : null) });
  const last = always.requests.filter(r => !('since' in r)).at(-1);
  assert.equal(last.limit, undefined);
  assert.ok(always.pipeline.peekServerEntry(always.ids[2499]));
});

test('a server that does not page answers in one response and needs no catch-up delta', async t => {
  const { requests, ids, pipeline } = await pagedHarness(t, { total: 300, pages: false });
  assert.equal(requests.filter(r => !('since' in r)).length, 1);
  assert.ok(pipeline.peekServerEntry(ids[299]));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(requests.filter(r => 'since' in r).length, 0);
});

test('once the stored copy holds a large library, memory keeps only what cards read', async t => {
  const { ids, stored, pipeline } = await pagedHarness(t, { total: 20500 });
  assert.ok(pipeline.peekServerEntry(ids[20499]), 'memory is complete until the copy is committed');
  for (let i = 0; i < 600 && !stored.committed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stored.committed, true);
  assert.equal(stored.entries, 20500);
  await settle();
  assert.equal(pipeline.peekServerEntry(ids[20499]), null, 'memory released after the commit');
  const read = await pipeline.lookupServerEntries([ids[7], ids[20499]]);
  assert.equal(read.get(ids[20499])?.stored, true, 'read back from the stored copy');
  assert.equal(read.size, 2);
});
