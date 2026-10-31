// Invoked by ApiItemLookMutationTests against its real controller/validator host.
import assert from 'node:assert/strict';
import { createHarness, deferred } from './harness.mjs';

const [origin, scenario] = process.argv.slice(2);
const A = '00000000000000000000000000000001', B = '00000000000000000000000000000002';
const patches = [], gate = deferred();
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
        if (scenario.startsWith('queued-') && patches.length === 1) await gate.promise;
      }
      return request(path, body);
    },
  },
});
let ctx;
try {
  h.window.Element.prototype.scrollIntoView = () => {};
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'enhanced/admintags/admin-tags.js', 'enhanced/admintags/sections/rules.js', 'enhanced/admintags/sections/quality.js']) h.load(file);
  ctx = h.JE.adminTags.createPage(h.document.getElementById('root'), await get());
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
  } else throw new Error(`Unknown scenario ${scenario}`);
  assert.equal(h.document.querySelector('#jeTaSaved').dataset.state, 'saved');
  console.log(`${scenario}: production page/store/transport and HTTP validator passed (${patches.length} patches)`);
} finally { ctx?.dispose(); h.close(); }
