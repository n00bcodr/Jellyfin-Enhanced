import test from 'node:test';
import assert from 'node:assert/strict';

import { resolve } from 'node:path';
import { deferred, plain } from '../../../helpers/harness.mjs';
import { BASE, LIBRARY, TWO_PAGES, boot, serverPatch, setup } from '../../../helpers/admin-tags-page.mjs';

test('Rules: add, switch off, reorder, delete with undo, and JSON with the old checks', async t => {
  const h = setup(t);
  await h.settle();
  h.change(h.$('[data-rule="field"]'), 'type');
  h.$('[data-rule="value"]').value = 'Episode';
  h.$('[data-rule="layout"]').value = 'bands';
  h.$('[data-rule="density"]').value = 'compact';
  h.$('[data-rule="add"]').click();
  h.change(h.$('[data-rule="field"]'), 'library');
  h.$('[data-rule="value"]').value = LIBRARY;
  h.$('[data-rule="layout"]').value = 'corners';
  h.$('[data-rule="density"]').value = 'full';
  h.$('[data-rule="add"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLookRules.map((r) => [r.When[0].Field, r.When[0].Value, r.Layout, r.Density])), [['type', 'Episode', 'bands', 'compact'], ['library', LIBRARY, 'corners', 'full']]);
  assert.match(h.$('.je-ta-rule[data-index="1"]').textContent, /Library is Movies/, 'library rules show the library name');
  h.change(h.$('.je-ta-rule[data-index="0"] [data-act="enable"]'), false);
  h.$('.je-ta-rule[data-index="1"] [data-act="move"][data-dir="-1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLookRules.map((r) => [r.When[0].Field, r.Enabled])), [['library', true], ['type', false]]);
  h.$('.je-ta-rule[data-index="0"] [data-act="delete"]').click();
  await h.save();
  assert.equal(h.server.TagLookRules.length, 1);
  h.$('.je-ta-snack .je-ta-button').click();
  await h.save();
  assert.equal(h.server.TagLookRules.length, 2, 'undo restores the deleted rule');
  // JSON: invalid input is refused with the reason; valid input replaces the rules (per-shape looks kept).
  const box = h.$('#tagLookRulesJson');
  box.value = '[{"when": [{"field": "library", "value": "nope"}], "layout": "bands"}]';
  box.dispatchEvent(new h.window.Event('input'));
  h.$('[data-rule="json-save"]').click();
  assert.match(h.$('#tagLookRulesJsonStatus').textContent, /Rule 1: a library condition needs a library id\./);
  box.value = JSON.stringify([{ when: [{ field: 'genre', value: 'Anime' }], layout: 'minimal', shapes: { landscape: { layout: 'bands' } } }]);
  box.dispatchEvent(new h.window.Event('input'));
  h.$('[data-rule="json-save"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLookRules), [{ Id: '', Enabled: true, When: [{ Field: 'genre', Value: 'Anime' }], Layout: 'minimal', Density: 'full', ColourPreset: null, Slots: null, Shapes: { landscape: { layout: 'bands' } } }]);
});


test('Rules: server-wide item looks are listed with titles; Remove saves and can be undone; Edit saves what the item editor hands back', async t => {
  const MOVIE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const SERIES = 'cccccccccccccccccccccccccccccccc';
  const EPISODE = 'dddddddddddddddddddddddddddddddd';
  const stored = [
    { ItemId: MOVIE, Layout: 'caption', Density: 'full', LockedAt: 9 },
    { ItemId: SERIES, Layout: 'bands', Density: 'compact', Scope: 'item', LockedAt: 5 },
  ];
  const titles = [];
  const h = setup(t, {
    config: { TagLookItemOverrides: stored },
    apiClient: {
      getJSON: async (url) => {
        if (url.includes('/Items/Filters')) return { Genres: [], OfficialRatings: [] };
        if (!url.includes('/Items')) return [{ ItemId: LIBRARY, Name: 'Movies' }];
        titles.push(new URL(url).searchParams.get('Ids'));
        return { Items: [{ Id: MOVIE, Name: 'Movie <i>One</i>', Type: 'Movie' }, { Id: SERIES, Name: 'Series One', Type: 'Series' }] };
      },
    },
  });
  await h.settle(); await h.settle(); await h.settle();
  const rows = () => h.$$('[data-item-looks] [data-item]');
  assert.deepEqual(rows().map((r) => r.dataset.item), [MOVIE, SERIES], 'newest first');
  assert.deepEqual(titles, [`${MOVIE},${SERIES}`], 'titles in one request');
  assert.match(rows()[0].textContent, /Movie <i>One<\/i>/);
  assert.equal(rows()[0].querySelector('i'), null, 'names are text');
  assert.match(rows()[1].textContent, /This series poster only/, 'a series poster only look says so');
  assert.equal(h.$('[data-item-looks-empty]').hidden, true);

  rows()[0].querySelector('[data-act="remove"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLookItemOverrides.map((o) => o.ItemId)), [SERIES]);
  assert.deepEqual(Object.keys(h.patches.at(-1).Changes), ['TagLookItemOverrides']);
  assert.deepEqual(plain(h.patches.at(-1).Changes.TagLookItemOverrides.Expected), { [MOVIE]: stored[0] }, 'only the removed entry is expected');
  h.$('.je-ta-snack .je-ta-button').click();
  await h.save();
  assert.deepEqual(plain([...h.JE.core.tagLook.normalizeItemOverrides(h.server.TagLookItemOverrides)]), plain([...h.JE.core.tagLook.normalizeItemOverrides(stored)]), 'undo puts it back');

  // Edit: the item editor in its server mode hands the look back to the page.
  const opened = [];
  h.JE.tagItemEditor = { open: (id, options) => { opened.push([id, options]); return Promise.resolve(true); } };
  rows()[1].querySelector('[data-act="edit"]').click();
  assert.equal(opened[0][0], SERIES);
  assert.equal(opened[0][1].mode, 'server');
  assert.equal(opened[0][1].look.scope, 'item', 'starts from the stored look');
  opened[0][1].onSave({ layout: 'minimal', density: 'full', scope: null }, SERIES);
  await h.save();
  const series = h.server.TagLookItemOverrides.find((o) => o.ItemId === SERIES);
  assert.deepEqual([series.Layout, series.Scope], ['minimal', null]);
  assert.equal(h.server.TagLookItemOverrides[0].ItemId, SERIES, 'the edited look is the newest');
  // An episode's look moved to its series: the episode's entry goes, the series' takes it.
  h.ctx.set('TagLookItemOverrides', [{ ItemId: EPISODE, Layout: 'bands', Density: 'full', LockedAt: 1 }]);
  await h.save();
  rows()[0].querySelector('[data-act="edit"]').click();
  opened.at(-1)[1].onSave({ layout: 'summary', density: 'full', scope: null }, SERIES);
  await h.save();
  assert.deepEqual(plain(h.server.TagLookItemOverrides.map((o) => [o.ItemId, o.Layout])), [[SERIES, 'summary']]);
});

for (const outcome of ['answer', 'rejection']) test(`Rules: a view replaced while its item titles load (${outcome}) does not leave the new view's rows loading`, async t => {
  // 51 looks: two batches of titles. The first view's first batch is held while Jellyfin builds another page.
  const looks = Array.from({ length: 51 }, (_, i) => ({ ItemId: (i + 1).toString(16).padStart(32, '0'), Layout: 'bands', Density: 'full', LockedAt: 100 - i }));
  const held = deferred();
  const requests = [];
  const h = boot(t, {
    server: { ...BASE, TagLookItemOverrides: looks },
    apiClient: {
      getJSON: async (url) => {
        if (!url.includes('/Items')) return [];
        const ids = new URL(url).searchParams.get('Ids').split(',');
        requests.push(ids);
        if (requests.length === 1) return held.promise;
        return { Items: ids.map((id) => ({ Id: id, Name: `Title ${id}`, Type: 'Movie' })) };
      },
    },
  });
  h.document.body.innerHTML = TWO_PAGES;
  const pages = h.document.querySelectorAll('.page');
  const first = await h.A.activate(pages[0]);
  const second = await h.A.activate(pages[1]);
  h.cleanup.push(() => second.dispose());
  for (let i = 0; i < 5; i++) await h.settle();
  assert.equal(first.disposed, true);
  assert.deepEqual(requests.map((r) => r.length), [50, 50, 1], 'the new view asks for every title itself');
  if (outcome === 'answer') held.resolve({ Items: requests[0].map((id) => ({ Id: id, Name: `Old ${id}`, Type: 'Movie' })) });
  else held.reject(new Error('signed out'));
  for (let i = 0; i < 5; i++) await h.settle();
  assert.equal(requests.length, 3, 'the torn-down view asks for nothing more');
  const loading = () => Array.from(pages[1].querySelectorAll('[data-item-looks] strong')).filter((e) => e.textContent.includes('Loading…')).length;
  assert.equal(loading(), 0);
  assert.equal(pages[1].querySelector(`[data-item="${looks[50].ItemId}"] strong`).textContent, `Title ${looks[50].ItemId}`);
  assert.ok(!pages[1].textContent.includes('Old '), 'the old view\'s late answer is not shown');
  second.refresh();
  for (let i = 0; i < 5; i++) await h.settle();
  assert.equal(requests.length, 3, 'titles are asked for once per view');
  assert.equal(loading(), 0);
});

for (const editedTarget of [false, true]) test(`Rules: remove Undo preserves intervening additions, edits and removals (target edited: ${editedTarget})`, async t => {
  const MOVIE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', SERIES = 'cccccccccccccccccccccccccccccccc', EPISODE = 'dddddddddddddddddddddddddddddddd', OTHER = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const entry = (id, layout = 'bands') => ({ ItemId: id, Layout: layout, Density: 'full', LockedAt: 1 });
  const h = setup(t, { config: { TagLookItemOverrides: [entry(MOVIE), entry(SERIES), entry(OTHER)] } });
  await h.settle();
  h.$(`[data-item="${MOVIE}"] [data-act="remove"]`).click();
  await h.save();
  h.ctx.set('TagLookItemOverrides', [entry(SERIES, 'summary'), entry(EPISODE, 'minimal'), ...(editedTarget ? [entry(MOVIE, 'caption')] : [])]);
  await h.save();
  h.$('.je-ta-snack .je-ta-button').click();
  await h.save();
  const looks = new Map(h.server.TagLookItemOverrides.map(e => [e.ItemId, e.Layout]));
  assert.equal(looks.get(MOVIE), editedTarget ? 'caption' : 'bands');
  assert.equal(looks.get(SERIES), 'summary');
  assert.equal(looks.get(EPISODE), 'minimal');
  assert.equal(looks.has(OTHER), false);
});

for (const move of [false, true]) test(`Rules Edit through the real item editor returns focus after save (move to series: ${move})`, async t => {
  const ITEM = 'dddddddddddddddddddddddddddddddd', SERIES = 'cccccccccccccccccccccccccccccccc';
  const h = setup(t, {
    config: { TagLookItemOverrides: [{ ItemId: ITEM, Layout: 'bands', Density: 'full', LockedAt: 1 }] },
    apiClient: {
      getItem: async (_, id) => ({ Id: id, Name: id === SERIES ? 'Series' : 'Episode', Type: id === SERIES ? 'Series' : 'Episode', SeriesId: SERIES }),
      getJSON: async () => ({ Items: [{ Id: ITEM, Name: 'Episode', Type: 'Episode' }, { Id: SERIES, Name: 'Series', Type: 'Series' }] }),
    },
  });
  h.JE.currentSettings = { tagLayoutSettingsVersion: 1, tagLayout: 'corners', qualityTagsEnabled: true };
  h.load('enhanced/settingspanel/ui-panel-tag-preview.js');
  h.load('tags/tag-item-editor.js');
  h.ctx.openTab('rules');
  await h.settle(); await h.settle();
  const original = h.$(`[data-item="${ITEM}"] [data-act="edit"]`);
  original.focus(); original.click();
  await h.settle(); await h.settle();
  const dialog = h.document.querySelector('.je-tie');
  assert.ok(dialog, 'real editor opened');
  if (move) h.change(dialog.querySelector('input[name$="Scope"][value="series"]'), true);
  dialog.querySelector('[data-tie-save]').click();
  await h.save(); await h.settle();
  assert.equal(h.document.querySelector('.je-tie'), null);
  assert.equal(original.isConnected, false, 'ctx.set redrew the list');
  assert.equal(h.document.activeElement, h.$(`[data-item="${move ? SERIES : ITEM}"] [data-act="edit"]`), 'replacement target Edit owns focus even after the save response redraw');
});
