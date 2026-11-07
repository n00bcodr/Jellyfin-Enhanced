import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness } from '../helpers/harness.mjs';

// The import / preset change lists name each field and value the way the
// settings controls do (ui-panel-tag-portable.js fieldName / valueText), and
// keep the stored field name on the row for scripts and tests.
const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url)));
const translate = (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), en[key] || key);

function setup(t) {
  const h = createHarness({ JE: { currentSettings: {}, pluginConfig: {}, t: translate, escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`) } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/tag-layout.js', 'enhanced/settingspanel/ui-panel-tag-portable.js']) h.load(file);
  return h.JE.internals.enhancedUi.tagPortable;
}

test('change lists use the settings labels and option names, not stored keys', t => {
  const P = setup(t);
  assert.equal(P.fieldName('TagLayout'), 'Layout');
  assert.equal(P.fieldName('TagScale'), en.tag_scale_label);
  assert.equal(P.fieldName('GenreTagsEnabled'), `${en.common_genre} tags`);
  assert.equal(P.fieldName('StatusTagsJustAddedDays'), 'Status Tags Just Added Days', 'a field without a control label is spelled out');
  assert.equal(P.valueText('larger', 'TagScale'), '115%');
  assert.equal(P.valueText('minimal', 'TagLayout'), 'Minimal', 'the option name, not the stored value');
  assert.equal(P.valueText('compact', 'TagLabelDensity'), en.panel_settings_ui_tag_density_compact);
  assert.equal(P.valueText(null, 'TagScale'), 'Server default');
  assert.equal(P.valueText(true), 'On');
  assert.equal(P.valueText('unknown-value', 'TagLayout'), 'unknown-value', 'a value without an option stays as stored');

  const html = P.previewHtml({ changes: [{ field: 'TagScale', from: null, to: 'larger' }], skipped: [{ field: 'Foo', reason: 'unknown' }] });
  assert.match(html, /data-je-field="TagScale">Tag size</);
  assert.match(html, /data-je-field="Foo">Foo</);
});
