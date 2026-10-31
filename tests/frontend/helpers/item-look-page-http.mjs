// Invoked by ApiItemLookMutationTests against its real controller/validator host.
import assert from 'node:assert/strict';
import { createHarness, deferred } from './harness.mjs';

const [origin, scenario] = process.argv.slice(2);
const A = '00000000000000000000000000000001', B = '00000000000000000000000000000002', C = '00000000000000000000000000000003', D = '00000000000000000000000000000004';
const patches = [], gate = deferred();
const holdAt = scenario.startsWith('pending-restore-') ? 2 : 1;
/** Wait for the real dialog/store's asynchronous continuation. */
async function wait(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Page flow did not settle');
}
const get = async () => (await fetch(`${origin}/test/configuration`)).json();
async function request(path, body) {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Admin': '1' }, body: JSON.stringify(body) });
  if (!response.ok) { const error = await response.json(); throw { status: response.status, error, json: async () => error }; }
  return response.json();
}
const h = createHarness({
  html: '<div id="root"></div>',
  JE: { t: k => k, pluginConfig: {}, currentSettings: {} },
  apiClient: {
    getUrl: path => `${origin}${path}`,
    getPluginConfiguration: get,
    getJSON: async () => ({ Items: [] }),
    ajax: async req => {
      const path = new URL(req.url).pathname;
      if (req.type !== 'POST') return null;
      const body = JSON.parse(req.data);
      if (path.endsWith('/admin/configuration')) {
        patches.push(body);
        if (scenario.startsWith('pending-') && patches.length === holdAt) {
          await gate.promise;
          if (scenario.endsWith('-failure')) return request(path, { Changes: { TagLookItemOverrides: 17 } });
          if (scenario.endsWith('-lost')) {
            await request(path, body);
            throw new TypeError('replacement response lost after apply');
          }
        }
        if ((scenario.startsWith('queued-') || scenario.startsWith('failed-undo-')) && patches.length === 1) await gate.promise;
        if (scenario.startsWith('failed-undo-') && patches.length === 1) {
          if (scenario.endsWith('lost-response')) {
            await request(path, body);
            throw new TypeError('response lost after the HTTP host acknowledged removal');
          }
          // Exercise a real, definitive validator rejection without applying the intended removal.
          return request(path, { Changes: { TagLookItemOverrides: { Set: null, Remove: [], Expected: {} } } });
        }
      }
      return request(path, body);
    },
  },
});
let ctx;
try {
  h.window.Element.prototype.scrollIntoView = () => {};
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'enhanced/settingspanel/ui-panel-tag-portable.js', 'enhanced/admintags/admin-tags.js', 'enhanced/admintags/sections/rules.js', 'enhanced/admintags/sections/quality.js', 'enhanced/admintags/sections/portable.js']) h.load(file);
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  ctx = h.JE.adminTags.createPage(h.document.getElementById('root'), await get(), { confirm: async () => true });
  const button = (id, action) => h.document.querySelector(`[data-item="${id}"] [data-act="${action}"]`);
  const undo = () => h.document.querySelector('.je-ta-snack .je-ta-button').click();
  if (scenario.startsWith('queued-')) {
    let onSave;
    h.JE.tagItemEditor = { open: (_, options) => { onSave = options.onSave; } };
    button(A, 'edit').click(); onSave({ layout: 'summary', density: 'full' }, A);
    const saving = ctx.flush();
    if (scenario === 'queued-add' || scenario === 'queued-edit') {
      button(A, 'edit').click(); onSave({ layout: 'corners', density: 'compact' }, A);
    } else {
      button(A, 'remove').click();
      if (scenario === 'queued-undo') undo();
    }
    const fresh = await get();
    const remote = { ItemId: B, Layout: 'minimal', Density: 'full', LockedAt: 2 };
    await request('/JellyfinEnhanced/admin/configuration', { Changes: { TagLookItemOverrides: [...fresh.TagLookItemOverrides.filter(e => e.ItemId !== B), remote] } });
    gate.resolve();
    assert.equal(await saving, true);
    const final = (await get()).TagLookItemOverrides;
    assert.equal(final.find(e => e.ItemId === B)?.Layout, 'minimal');
    assert.ok(patches.every(p => !p.Changes.TagLookItemOverrides.Remove.includes(B)));
    if (scenario === 'queued-add' || scenario === 'queued-edit') assert.equal(final.find(e => e.ItemId === A)?.Layout, 'corners');
    else assert.equal(final.some(e => e.ItemId === A), scenario === 'queued-undo');
  } else if (scenario.startsWith('failed-undo-')) {
    h.expectConsoleError('could not save the Media Tags settings');
    const initial = (await get()).TagLookItemOverrides;
    button(A, 'remove').click();
    const saving = ctx.flush();
    undo(); gate.resolve();
    assert.equal(await saving, false);
    assert.equal(h.document.querySelector('#jeTaSaved').dataset.state, 'error');
    if (scenario.endsWith('lost-response')) assert.equal((await get()).TagLookItemOverrides ?? null, null);
    assert.equal(await ctx.flush(), true);
    assert.deepEqual((await get()).TagLookItemOverrides, initial);
    assert.equal(patches.length, scenario.endsWith('lost-response') ? 2 : 1);
  } else if (scenario.startsWith('immediate-undo')) {
    const initial = await get();
    button(A, 'remove').click(); undo();
    if (scenario.endsWith('with-field')) ctx.set('QualityTagsEnabled', !initial.QualityTagsEnabled);
    assert.equal(await ctx.flush(), true);
    assert.deepEqual((await get()).TagLookItemOverrides, initial.TagLookItemOverrides);
    assert.equal(patches.length, scenario.endsWith('with-field') ? 1 : 0);
    if (patches.length) {
      assert.equal('TagLookItemOverrides' in patches[0].Changes, false);
      assert.equal((await get()).QualityTagsEnabled, !initial.QualityTagsEnabled);
    }
  } else if (scenario === 'already-absent') {
    await request('/JellyfinEnhanced/admin/configuration', { Changes: { TagLookItemOverrides: null } });
    assert.equal(await h.JE.core.tagLook.saveItemOverride(A, null), true);
    assert.equal(patches.length, 0, 'a fresh GET that already lacks the target needs no PATCH');
    assert.equal(h.JE.pluginConfig.TagLookItemOverrides, null);
  } else if (scenario.startsWith('pending-')) {
    const initial = (await get()).TagLookItemOverrides;
    const replacement = [B, C].map((ItemId, i) => ({ ...initial[0], ItemId, LockedAt: 10 - i }));
    const restoring = scenario.startsWith('pending-restore-');
    const conflict = scenario.includes('-conflict-');
    if (!conflict) h.expectConsoleError('could not save the Media Tags settings');
    ctx.openTab('server');
    h.document.querySelector('#jeTaImport').click();
    h.document.querySelector('[data-pt-paste]').value = JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLookItemOverrides: replacement } });
    h.document.querySelector('[data-pt-action="next"]').click();
    await wait(() => h.document.querySelector('[data-pt-action="apply"]'));
    h.document.querySelector('[data-pt-action="apply"]').click();
    if (restoring) {
      await wait(() => h.document.querySelector('.je-ta-snack .je-ta-button'));
      undo();
    }
    await wait(() => patches.length === holdAt);
    h.document.querySelector('[data-pt-close]')?.click();
    ctx.openTab('rules');
    let onSave;
    h.JE.tagItemEditor = { open: (_, options) => { onSave = options.onSave; } };
    const target = restoring ? A : B;
    const removing = scenario.includes('-remove-');
    if (removing) button(target, 'remove').click();
    else { button(target, 'edit').click(); onSave({ layout: 'summary', density: 'full' }, target); }
    const remote = [{ ...initial[0], ItemId: D, Layout: 'minimal' }];
    if (conflict) await request('/JellyfinEnhanced/admin/configuration', { Changes: { TagLookItemOverrides: remote } });
    const saving = ctx.flush();
    gate.resolve();
    assert.equal(await saving, false);
    assert.equal(h.document.querySelector('#jeTaSaved').dataset.state, conflict ? 'conflict' : 'error');
    if (!conflict) {
      const retry = await ctx.flush();
      if (scenario.endsWith('-lost')) assert.equal(retry, false, 'unknown replacement outcome conflicts as a whole');
      else assert.equal(retry, true);
    }
    if (conflict || scenario.endsWith('-lost')) {
      h.document.querySelector(scenario.endsWith('-theirs') ? '[data-je-theirs]' : '[data-je-keep]').click();
      await wait(() => h.document.querySelector('#jeTaSaved').dataset.state === 'saved');
    }
    const final = (await get()).TagLookItemOverrides;
    const ids = final.map(e => e.ItemId).sort();
    assert.deepEqual(ids, scenario.endsWith('-theirs') ? [D] : restoring ? [A] : removing ? [C] : [B, C]);
    if (!removing && !scenario.endsWith('-theirs')) assert.equal(final.find(e => e.ItemId === target).Layout, 'summary');
    const retries = patches.slice(holdAt);
    assert.ok(retries.every(p => Array.isArray(p.Changes.TagLookItemOverrides)), 'unacknowledged replacement stays whole-list transport');
    if (scenario.endsWith('-mine')) assert.deepEqual([...h.JE.core.tagLook.normalizeItemOverrides(retries.at(-1).Expected.TagLookItemOverrides)], [...h.JE.core.tagLook.normalizeItemOverrides(remote)]);
    // Only the final acknowledgement releases replacement mode.
    button(final[0].ItemId, 'edit').click(); onSave({ layout: 'bands', density: 'compact' }, final[0].ItemId);
    assert.equal(await ctx.flush(), true);
    assert.equal(patches.at(-1).Changes.TagLookItemOverrides.Set.length, 1);
  } else if (scenario === 'import-replace') {
    const initial = (await get()).TagLookItemOverrides;
    const replacement = initial.map((e, i) => ({ ...e, ItemId: (i + 501).toString(16).padStart(32, '0') }));
    const wait = async predicate => {
      for (let i = 0; i < 300; i++) {
        if (predicate()) return;
        await new Promise(r => setTimeout(r, 20));
      }
      throw new Error('Import flow did not settle');
    };
    ctx.openTab('server');
    h.document.querySelector('#jeTaImport').click();
    h.document.querySelector('[data-pt-paste]').value = JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLookItemOverrides: replacement } });
    h.document.querySelector('[data-pt-action="next"]').click();
    await wait(() => h.document.querySelector('[data-pt-action="apply"]'));
    h.document.querySelector('[data-pt-action="apply"]').click();
    await wait(() => h.document.querySelector('.je-ta-snack .je-ta-button') || h.document.querySelector('#jeTaSaved').dataset.state === 'error');
    assert.equal(h.document.querySelector('#jeTaSaved').dataset.state, 'saved');
    assert.ok(Array.isArray(patches[0].Changes.TagLookItemOverrides), 'import retains array replacement transport');
    assert.deepEqual(patches[0].Expected.TagLookItemOverrides, initial);
    assert.equal((await get()).TagLookItemOverrides.length, 500);
    assert.deepEqual((await get()).TagLookItemOverrides.map(e => e.ItemId), replacement.map(e => e.ItemId));
    // An edit immediately after import returns to bounded per-entry transport.
    ctx.openTab('rules');
    let onSave;
    h.JE.tagItemEditor = { open: (_, options) => { onSave = options.onSave; } };
    button(replacement[0].ItemId, 'edit').click(); onSave({ layout: 'bands', density: 'compact' }, replacement[0].ItemId);
    assert.equal(await ctx.flush(), true);
    assert.equal(patches[1].Changes.TagLookItemOverrides.Set.length, 1);
    assert.equal(patches[1].Changes.TagLookItemOverrides.Remove.length, 0);
    undo();
    assert.equal(await ctx.flush(), true);
    assert.ok(Array.isArray(patches[2].Changes.TagLookItemOverrides), 'import Undo is an explicit replacement');
    assert.deepEqual((await get()).TagLookItemOverrides, initial);
    assert.equal(Buffer.byteLength(JSON.stringify(patches[0])) < 8 * 1024 * 1024, true);
  } else throw new Error(`Unknown scenario ${scenario}`);
  assert.equal(h.document.querySelector('#jeTaSaved').dataset.state, 'saved');
  console.log(`${scenario}: production page/store/transport and HTTP validator passed (${patches.length} patches)`);
} finally { ctx?.dispose(); h.close(); }
