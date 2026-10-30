import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { createHarness, plain } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// The configuration page cannot load the client bundle, so its tag layout
// defaults editor carries a copy of the layout rules (pending P1b-2: one
// shared module). Until then this keeps the copy from drifting from
// core/tag-layout.js and the panel editor's stepper rules.

/** The constants block of the page's tagLayoutAdmin, evaluated on its own. */
function pageRules() {
  const html = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
  const start = html.indexOf('var tagLayoutAdmin = (function () {');
  assert.ok(start > 0, 'tagLayoutAdmin found');
  const from = html.indexOf('var GROUPS = {', start);
  const to = html.indexOf('var MAX_CAP = ', from);
  const end = html.indexOf(';', to) + 1;
  assert.ok(from > start && to > from, 'constants block found');
  const source = `${html.slice(from, end)}\n({ GROUPS, DEFAULT_ORDER, DEFAULT_CAPS, LAYOUT_SLOTS, DEFAULT_PROFILES, SLOT_LABELS, POS_TO_SLOT, SLOT_TO_POS, MAX_CAP })`;
  return vm.runInNewContext(source);
}

test('the configuration page\'s layout rules match the layout controller and the panel editor', t => {
  const page = pageRules();
  const h = createHarness({ JE: { currentSettings: {}, pluginConfig: {}, t: key => key } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js']) h.load(file);
  const L = h.JE.core.tagLayout;

  assert.deepEqual(plain(page.DEFAULT_ORDER), plain(L.DEFAULT_ORDER));
  assert.deepEqual(plain(page.DEFAULT_CAPS), plain(L.DEFAULT_CAPS));
  assert.deepEqual(plain(page.LAYOUT_SLOTS), plain(L.LAYOUT_SLOTS));
  assert.deepEqual(plain(page.DEFAULT_PROFILES), plain(L.DEFAULT_PROFILES));
  assert.deepEqual(plain(page.POS_TO_SLOT), plain(L.POSITION_TO_SLOT));
  assert.deepEqual(plain(page.SLOT_TO_POS), plain(L.SLOT_TO_POSITION));
  assert.deepEqual(plain(Object.keys(page.GROUPS).sort()), plain(L.DEFAULT_ORDER.slice().sort()));
  for (const [group, meta] of Object.entries(page.GROUPS)) {
    assert.equal(meta.position, L.POSITION_SETTINGS[group].userKey, `${group} position select`);
  }
  for (const [layout, slots] of Object.entries(page.LAYOUT_SLOTS)) {
    assert.deepEqual(plain(Object.keys(page.SLOT_LABELS[layout])), plain(slots.filter(s => s !== 'off')), `${layout} labels every slot`);
  }

  // Stepper limits: the panel editor's nextCap against the page's flags and MAX_CAP.
  h.load('enhanced/settingspanel/ui-panel-tag-editor.js');
  h.document.body.innerHTML = '<div id="jeTagGroupEditor"><ol class="je-tge-rows"></ol></div>';
  h.JE.internals.enhancedUi.wireTagGroupEditor({});
  const { nextCap } = h.JE.internals.enhancedUi.tagGroupEditor;
  for (const [group, meta] of Object.entries(page.GROUPS)) {
    if (meta.capFixed) {
      assert.equal(nextCap(group, 1, 1), null, `${group} is fixed at one`);
      continue;
    }
    assert.equal(nextCap(group, page.MAX_CAP - 1, 1), page.MAX_CAP, `${group} reaches MAX_CAP`);
    assert.equal(nextCap(group, page.MAX_CAP, 1), meta.capAll ? 0 : null, `${group} ${meta.capAll ? 'offers' : 'has no'} All`);
  }
});

test('admin shape defaults load and collect recommendations, preserve custom looks, and detect unsaved changes', t => {
  const h = createHarness({ html: ['Landscape', 'List'].map(shape => `<select id="tagShape${shape}Default"><option value="inherit">inherit</option><option value="recommended">recommended</option><option value="custom" hidden>custom</option></select>`).join('') });
  t.after(() => h.close());
  const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
  const start = page.indexOf('var tagShapeAdmin = (function () {');
  const end = page.indexOf('})();', start) + 5;
  assert.ok(start > 0 && end > start);
  h.window.eval(`${page.slice(start, end)}; window.shapeDefaults = tagShapeAdmin;`);
  const admin = h.window.shapeDefaults;
  const custom = { Layout: 'summary', Density: 'full', Slots: [{ Group: 'rating', Slot: 'pill' }], Caps: { Rating: 1 } };
  admin.load({ TagShapeOverrides: { Landscape: custom, List: null } });
  assert.equal(h.document.querySelector('#tagShapeLandscapeDefault').value, 'custom');
  const before = admin.snapshot();
  h.document.querySelector('#tagShapeListDefault').value = 'recommended';
  assert.notEqual(admin.snapshot(), before);
  const collected = {};
  admin.collect(collected);
  assert.deepEqual(plain(collected.TagShapeOverrides.Landscape), custom);
  assert.equal(collected.TagShapeOverrides.List.Layout, 'corners');
  assert.equal(collected.TagShapeOverrides.List.Caps.Quality, 2);
  admin.load(collected);
  assert.equal(h.document.querySelector('#tagShapeListDefault').value, 'recommended');
  for (const el of h.document.querySelectorAll('select')) el.value = 'inherit';
  admin.collect(collected);
  assert.equal(collected.TagShapeOverrides, null);
});
