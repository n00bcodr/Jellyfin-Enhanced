// Review round 1 (h2): linked-source menu mutations, the collection refresh after a sync, and the importer's
// library check of a changed match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, view, tick, LIST, COLLECTION } from './lp-harness.mjs';

const until = async (fn, tries = 200) => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await tick(); } throw new Error('timeout'); };
const plainJson = value => JSON.parse(JSON.stringify(value));
const ok = (index, match, extra = {}) => ({ index, state: 'ok', confidence: 'high', kind: match?.mediaType === 'tv' ? 'series' : 'movie', match, candidates: match ? [match] : [], reasons: [], alternatives: false, ...extra });
const show = (tmdbId, title, extra = {}) => ({ mediaType: 'tv', tmdbId, title, year: 2016, releaseDate: '2016-01-21', posterPath: `/p${tmdbId}.jpg`, overview: 'o', score: 160, ...extra });

/** A gate: `wait` resolves once `open()` is called. */
function gate() {
  let open;
  const wait = new Promise((resolve) => { open = resolve; });
  return { wait, open };
}

/**
 * Loads the modules plus modal.js; `plugin` answers the list-placeholders routes.
 * @param {*} t
 * @param {Object} [options]
 */
function setupImport(t, { plugin } = {}) {
  const h = setup(t, {
    plugin: plugin || (async () => ({})),
    jellyseerrAPI: {
      search: async () => ({ results: [] }),
      fetchTvShowDetails: async () => ({ id: 1, name: 'Show', seasons: [{ seasonNumber: 1, episodeCount: 8, airDate: '2016-01-21' }] }),
      fetchTvSeasonDetails: async () => ({ episodes: [{ episodeNumber: 1, name: 'One', airDate: '2016-01-21' }] })
    }
  });
  h.load('jellyseerr/modal.js');
  return h;
}

/**
 * A page controller stand-in that adopts published views (as the real controllers do on the view event).
 * @param {Object} h - Harness.
 * @param {Object} initial - Starting view.
 * @returns {Object}
 */
function fakeController(h, initial) {
  const ctrl = { listId: LIST, listKind: 'playlist', view: initial, isAlive: () => true, load: async () => {} };
  h.document.addEventListener(h.lp.events.VIEW, (e) => {
    if (e.detail?.listId === ctrl.listId && !h.lp.isOlderView(e.detail.view, ctrl.view)) ctrl.view = e.detail.view;
  });
  return ctrl;
}

const linked = { kind: 'mdblist', url: 'https://mdblist.com/lists/a/b', syncEnabled: true, removeDropped: false, lastSyncAt: '2026-10-10T10:00:00Z', lastSync: { state: 'ok' } };

test('F56: a source option change made while another is still saving is built from the saved view, not the stale one', async t => {
  const puts = [];
  const gates = [];
  let rev = 1;
  const h = setupImport(t, {
    plugin: async (path, options = {}) => {
      if (path !== `/list-placeholders/${LIST}/source` || options.method !== 'PUT') return {};
      const body = plainJson(options.body);
      puts.push(body);
      const g = gate();
      gates.push(g);
      await g.wait;
      return view({ rev: ++rev, source: { ...linked, syncEnabled: body.syncEnabled, removeDropped: body.removeDropped } });
    }
  });
  const ctrl = fakeController(h, view({ rev: 1, source: linked }));
  const chip = h.document.createElement('button');
  // Untick "Keep in sync" (pending), then — from a menu built on the old view — tick "Remove entries…".
  const first = h.lp.sourceUi.setOptions(ctrl, { syncEnabled: false }, chip);
  const second = h.lp.sourceUi.setOptions(ctrl, { removeDropped: true }, chip);
  await until(() => puts.length >= 1);
  await tick();
  assert.equal(puts.length, 1, 'the second change waits for the first');
  assert.ok(chip.classList.contains('je-lp-source-busy'), 'the chip shows the pending change');
  gates[0].open();
  await first;
  await until(() => puts.length === 2);
  assert.deepEqual({ syncEnabled: puts[1].syncEnabled, removeDropped: puts[1].removeDropped }, { syncEnabled: false, removeDropped: true });
  gates[1].open();
  await second;
  assert.equal(ctrl.view.source.syncEnabled, false);
  assert.equal(ctrl.view.source.removeDropped, true);
  assert.ok(!chip.classList.contains('je-lp-source-busy'));
});

test('F56: Unlink waits for a pending option change, and a change queued behind Unlink does not re-link', async t => {
  const order = [];
  const putGate = gate();
  let rev = 1;
  const h = setupImport(t, {
    plugin: async (path, options = {}) => {
      if (path === `/list-placeholders/${LIST}/source` && options.method === 'PUT') {
        order.push('PUT');
        await putGate.wait;
        order.push('PUT done');
        return view({ rev: ++rev, source: { ...linked, syncEnabled: false } });
      }
      if (path.startsWith(`/list-placeholders/${LIST}/source?`) && options.method === 'DELETE') {
        order.push('DELETE');
        return view({ rev: ++rev });
      }
      return {};
    }
  });
  const ctrl = fakeController(h, view({ rev: 1, source: linked }));
  const put = h.lp.sourceUi.setOptions(ctrl, { syncEnabled: false });
  const unlink = h.lp.sourceUi.unlink(ctrl);
  const late = h.lp.sourceUi.setOptions(ctrl, { removeDropped: true });
  await until(() => order.length >= 1);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(order, ['PUT'], 'no DELETE while the PUT is running');
  putGate.open();
  await Promise.all([put, unlink, late]);
  assert.deepEqual(order, ['PUT', 'PUT done', 'DELETE']);
  assert.equal(ctrl.view.source, undefined);
});

test('F57: a sync that only removed entries reloads a collection\'s own cards (Sync now and a still-running sync)', async t => {
  const realSetTimeout = setTimeout;
  const h = setupImport(t);
  let refreshed = 0;
  const ctrl = { listId: COLLECTION, listKind: 'collection', view: view({ listId: COLLECTION, listKind: 'collection', source: linked }), isAlive: () => true, load: async () => {}, afterRealItemsAdded: () => { refreshed++; } };
  h.lp.api.syncSource = async () => ({ state: 'ok', added: 0, removed: 2, kept: 3, unresolved: 0 });
  await h.lp.sourceUi.syncNow(ctrl, null);
  assert.equal(refreshed, 1, 'Sync now that removed items');

  ctrl.load = async () => { ctrl.view = view({ listId: COLLECTION, listKind: 'collection', source: { ...linked, lastSyncAt: '2026-10-11T10:00:00Z', lastSync: { state: 'ok', added: 0, removed: 1 } } }); };
  h.lp.api.syncSource = async () => ({ state: 'running', message: 'still running' });
  h.window.setTimeout = (fn) => realSetTimeout(fn, 0);
  await h.lp.sourceUi.syncNow(ctrl, null);
  assert.equal(refreshed, 2, 'the polled result removed items');

  // Nothing added or removed: no reload.
  h.lp.api.syncSource = async () => ({ state: 'ok', added: 0, removed: 0, kept: 3, unresolved: 0 });
  await h.lp.sourceUi.syncNow(ctrl, null);
  assert.equal(refreshed, 2);
});

test('F58: the library check of an "A or B" row\'s changed scope is applied (the probe\'s match has no alternative)', async t => {
  const a = show(75, "DC's Legends of Tomorrow", { alternative: 0 });
  const b = show(76, 'Legends of Yesterday', { alternative: 1 });
  const probes = [];
  const h = setupImport(t, {
    plugin: async (path, options = {}) => {
      if (path !== '/list-placeholders/resolve') return {};
      const entry = options.body.entries[0];
      if (entry.ids) {
        probes.push(plainJson(entry));
        // /resolve answers a single-title probe: no alternatives, so its match carries no alternative index.
        return { results: [ok(0, show(76, 'Legends of Yesterday', { episodeTotal: 8, inLibrary: { itemId: 'e'.repeat(32), kind: 'series', episodeItemIds: ['a'.repeat(32)], complete: false } }))] };
      }
      return { results: [ok(0, a, { confidence: 'low', alternatives: true, reasons: ['alternatives'], candidates: [a, b] })] };
    }
  });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  root.querySelector('.je-lp-import-text').value = "DC's Legends of Tomorrow or Legends of Yesterday (2016)";
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-edit').click();
  const ed = root.querySelector('.je-lp-ieditor');
  const radio = ed.querySelectorAll('.je-lp-ieditor-cand input')[1];
  radio.checked = true;
  radio.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const done = ed.querySelector('.je-lp-ieditor-done');
  await until(() => !done.disabled);
  done.click();
  await until(() => probes.length === 1);
  for (let i = 0; i < 5; i++) await tick();
  await until(() => !root.querySelector('.je-lp-irow[data-i="0"]').textContent.includes('listPlaceholders_import_checking_library'));
  const row = root.querySelector('.je-lp-irow[data-i="0"]');
  assert.ok(row.querySelector('.je-lp-chip-lib'), row.outerHTML);
  assert.equal(row.querySelector('.je-lp-irow-action').value, 'item');
});

test('F59: a library check answered after Back and a new lookup leaves the new review\'s row alone', async t => {
  const probeGate = gate();
  let probes = 0;
  const h = setupImport(t, {
    plugin: async (path, options = {}) => {
      if (path !== '/list-placeholders/resolve') return {};
      const entry = options.body.entries[0];
      if (entry.ids) {
        probes++;
        await probeGate.wait;
        return { results: [ok(0, show(75, "DC's Legends of Tomorrow", { inLibrary: { itemId: 'e'.repeat(32), kind: 'series', episodeItemIds: ['a'.repeat(32)], complete: false } }))] };
      }
      const title = entry.title || '';
      return { results: [ok(0, title.includes('Second') ? show(500, 'Second Show') : show(75, "DC's Legends of Tomorrow"), { confidence: 'low', reasons: ['lowScore'] })] };
    }
  });
  const root = h.lp.importer.open({ mode: 'new' }).modalElement;
  const text = root.querySelector('.je-lp-import-text');
  text.value = "DC's Legends of Tomorrow (2016)";
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden);
  root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-edit').click();
  const ed = root.querySelector('.je-lp-ieditor');
  const done = ed.querySelector('.je-lp-ieditor-done');
  await until(() => !done.disabled);
  done.click();
  await until(() => probes === 1);

  // Back, and look up another list while the old row's library check is still running.
  root.querySelector('.je-lp-import-back').click();
  text.value = 'Second Show (2020)';
  root.querySelector('.jellyseerr-modal-button-primary').click();
  await until(() => root.querySelector('.je-lp-import-progress').hidden && root.querySelector('.je-lp-irow[data-i="0"]'));
  assert.equal(root.querySelector('.je-lp-irow[data-i="0"] .je-lp-irow-title').textContent, 'Second Show');
  const before = root.querySelector('.je-lp-irow[data-i="0"]').outerHTML;

  probeGate.open();
  for (let i = 0; i < 10; i++) await tick();
  const row = root.querySelector('.je-lp-irow[data-i="0"]');
  assert.equal(row.querySelector('.je-lp-irow-title').textContent, 'Second Show', 'the old row did not overwrite the new one');
  assert.equal(row.outerHTML, before);
});

/** A playlist controller mid-drag: published views wait in pendingView (ctrl.view stays as it was). */
function suspendedController(h, initial) {
  const ctrl = { listId: LIST, listKind: 'playlist', view: initial, pendingView: null, suspended: true, isAlive: () => true, load: async () => {} };
  h.document.addEventListener(h.lp.events.VIEW, (e) => {
    if (e.detail?.listId === ctrl.listId && !h.lp.isOlderView(e.detail.view, ctrl.pendingView || ctrl.view)) ctrl.pendingView = e.detail.view;
  });
  return ctrl;
}

test('R2: a queued option change starts from the previous change even while a drag holds the page view back', async t => {
  const puts = [];
  let rev = 1;
  const h = setupImport(t, {
    plugin: async (path, options = {}) => {
      if (path !== `/list-placeholders/${LIST}/source` || options.method !== 'PUT') return {};
      const body = plainJson(options.body);
      puts.push(body);
      return view({ rev: ++rev, source: { ...linked, syncEnabled: body.syncEnabled, removeDropped: body.removeDropped } });
    }
  });
  const ctrl = suspendedController(h, view({ rev: 1, source: linked }));
  const first = h.lp.sourceUi.setOptions(ctrl, { syncEnabled: false });
  const second = h.lp.sourceUi.setOptions(ctrl, { removeDropped: true });
  await first; await second;
  assert.equal(ctrl.view.rev, 1, 'the page still shows the old view');
  assert.deepEqual(puts.map(p => [p.syncEnabled, p.removeDropped]), [[false, false], [false, true]]);
});

test('R2: an option change queued behind Unlink does not re-link while a drag holds the page view back', async t => {
  const calls = [];
  let rev = 1;
  const h = setupImport(t, {
    plugin: async (path, options = {}) => {
      if (path === `/list-placeholders/${LIST}/source` && options.method === 'PUT') { calls.push('PUT'); return view({ rev: ++rev, source: linked }); }
      if (path.startsWith(`/list-placeholders/${LIST}/source?`) && options.method === 'DELETE') { calls.push('DELETE'); return view({ rev: ++rev }); }
      return {};
    }
  });
  const ctrl = suspendedController(h, view({ rev: 1, source: linked }));
  const unlink = h.lp.sourceUi.unlink(ctrl);
  const late = h.lp.sourceUi.setOptions(ctrl, { removeDropped: true });
  await unlink; await late;
  assert.deepEqual(calls, ['DELETE']);
});
