import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, BASE } from '../../helpers/admin-tags-page.mjs';

const root = new URL('../../../../', import.meta.url);
const english = JSON.parse(readFileSync(new URL('Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', root)));
const source = path => readFileSync(new URL(path, root), 'utf8');

test('every rendered admin tab shows its own name and description as plain English', t => {
  const h = boot(t, { server: BASE });
  const host = h.document.getElementById('jeTaRoot');
  const ctx = h.A.createPage(host, BASE);
  h.cleanup.push(() => ctx.dispose());
  for (const tab of h.A.TABS) {
    ctx.openTab(tab.id);
    const panel = host.querySelector(`#jeTaPanel-${tab.id}`);
    assert.equal(panel.querySelector('h2').textContent, tab.nameKey);
    assert.ok(panel.querySelector(':scope > .je-ta-hint').textContent.startsWith(tab.descKey), `${tab.id} description`);
    assert.match(panel.querySelector(':scope > .je-ta-hint .je-ta-docs').getAttribute('href'), /^https:\/\/n00bcodr\.github\.io\/Jellyfin-Enhanced\/enhanced\/tags\/#[a-z-]+$/);
  }
});

test('tag vocabulary preserves layout, visibility, dashboard and singular-type translation contexts', t => {
  const h = boot(t, { server: BASE });
  const v = h.JE.core.tagLayout.VOCABULARY_KEYS;
  for (const [actual, expected] of [
    [v.type.series, 'tag_looks_type_series'], [v.layout.summary, 'tag_layout_summary'],
    [v.group.status, 'panel_settings_ui_tag_group_status'], [v.slot.off, 'panel_settings_ui_tag_slot_off'],
    [v.adminTab.overview, 'admin_tags_tab_overview'],
  ]) {
    assert.equal(actual, expected);
    assert.equal(typeof english[expected], 'string');
  }
  for (const file of ['enhanced/admintags/admin-tags.js', 'enhanced/settingspanel/ui-panel-template.js',
    'enhanced/settingspanel/ui-panel-media-tags.js', 'enhanced/settingspanel/ui-panel-tag-editor.js', 'tags/tag-item-editor.js']) {
    const text = source(`Jellyfin.Plugin.JellyfinEnhanced/js/${file}`);
    assert.doesNotMatch(text, /['"](?:jellyseerr_issue_open|hidden_content_already_hidden|jellyseerr_discover_all)['"]/);
  }
  assert.equal(english.common_open, 'Open');
  assert.equal(english.panel_settings_ui_tag_editor_cap_all, 'All');
  const vocabulary = JSON.parse(source('Jellyfin.Plugin.JellyfinEnhanced/js/tags/status-vocabulary.json'));
  for (const kind of ['season_finale', 'series_finale']) {
    assert.equal(vocabulary.badges[kind].compact, 'status_tag_compact_finale');
  }
  assert.equal(english.status_tag_compact_finale, 'Finale');
});

test('dynamic tag translation families have an English value for every accepted option', t => {
  const h = boot(t, { server: BASE });
  const keys = Object.values(h.JE.core.tagLayout.VOCABULARY_KEYS).flatMap(Object.values);
  const families = {
    panel_settings_ui_tag_density_: ['full', 'compact'],
    panel_settings_ui_tag_layout_: ['corners', 'bands', 'caption', 'summary', 'minimal'],
    tag_shapes_: ['landscape', 'list'],
    tag_looks_cond_: ['library', 'type', 'genre', 'agerating'],
    series_quality_aggregation_: ['representative', 'latest', 'best', 'shared', 'mixed'],
    tag_portable_skip_: ['unknown', 'secret', 'signal', 'invalid'],
    tag_portable_error_: ['not_json', 'not_object', 'kind', 'version', 'newer', 'settings', 'name', 'description', 'empty', 'full', 'save'],
  };
  for (const [prefix, values] of Object.entries(families)) keys.push(...values.map(value => prefix + value));
  for (const kind of ['scale', 'gap']) for (const suffix of ['label', 'desc']) keys.push(`tag_${kind}_${suffix}`);
  for (const key of keys) assert.equal(typeof english[key], 'string', key);
});
