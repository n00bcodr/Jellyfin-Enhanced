// Review round 3: a source change still queued when the user switches is dropped (it would read the old user's view
// and send its mutation with the new user's token), and the controllers forget the queue on dispose/reactivate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, view, tick, playlistPage, LIST, ITEM_A } from './lp-harness.mjs';

const plainJson = value => JSON.parse(JSON.stringify(value));
const linked = { kind: 'mdblist', url: 'https://mdblist.com/lists/a/b', syncEnabled: true, removeDropped: false, lastSyncAt: '2026-10-10T10:00:00Z', lastSync: { state: 'ok' } };

test('R3: Unlink queued behind a running option change is dropped after a user switch', async t => {
  const calls = [];
  let openPut;
  const putGate = new Promise((resolve) => { openPut = resolve; });
  const h = setup(t, {
    plugin: async (path, options = {}) => {
      if (path === `/list-placeholders/${LIST}/source` && options.method === 'PUT') {
        calls.push(['PUT', plainJson(options.body)]);
        await putGate;
        return view({ rev: 2, source: { ...linked, syncEnabled: false } });
      }
      if (path.startsWith(`/list-placeholders/${LIST}/source?`) && options.method === 'DELETE') { calls.push(['DELETE']); return view({ rev: 3 }); }
      return {};
    }
  });
  const ctrl = { listId: LIST, listKind: 'playlist', view: view({ rev: 1, source: linked }), isAlive: () => true, load: async () => {} };
  const put = h.lp.sourceUi.setOptions(ctrl, { syncEnabled: false });
  const unlink = h.lp.sourceUi.unlink(ctrl);
  for (let i = 0; i < 5; i++) await tick();
  h.switchUser();
  openPut();
  await put; await unlink;
  assert.deepEqual(calls.map(c => c[0]), ['PUT']);
  assert.equal(h.toasts.length, 0, `no toast, got ${JSON.stringify(h.toasts)}`);
  assert.equal(ctrl.sourceView, undefined, 'the stale answer is not remembered');
});

test('R3: a change queued for a page that went away is dropped', async t => {
  const calls = [];
  const h = setup(t, { plugin: async (path, options = {}) => { calls.push(options.method); return view({ rev: 2 }); } });
  let alive = true;
  const ctrl = { listId: LIST, listKind: 'playlist', view: view({ rev: 1, source: linked }), isAlive: () => alive, load: async () => {} };
  const first = h.lp.sourceUi.setOptions(ctrl, { syncEnabled: false });
  const second = h.lp.sourceUi.unlink(ctrl);
  alive = false;
  await first; await second;
  assert.deepEqual(calls, []);
});

test('R3: the playlist controller forgets the source queue and its last answer on dispose and reactivate', async t => {
  const h = setup(t, { html: playlistPage([ITEM_A]), plugin: async () => view({ order: [`e:${ITEM_A}:0`] }) });
  h.JE.initializeListPlaceholders();
  const page = h.document.querySelector('.itemDetailPage');
  const ctrl = h.lp.playlist.attach(page, { Id: LIST, Name: 'Marathon', Type: 'Playlist' });
  for (let i = 0; i < 5; i++) await tick();
  ctrl.sourceView = view({ rev: 9, source: linked });
  ctrl.sourceQueue = Promise.resolve();
  ctrl.dispose();
  assert.equal(ctrl.sourceView, null);
  assert.equal(ctrl.sourceQueue, null);
  ctrl.sourceView = view({ rev: 9, source: linked });
  ctrl.reactivate();
  assert.equal(ctrl.sourceView, null);
});
