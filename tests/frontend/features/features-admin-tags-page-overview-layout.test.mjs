import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, plain, jsRoot } from '../helpers/harness.mjs';
import { setup, OLD_FORM, POSITION_GROUPS, ALSO_WRITES, PAGE_FIELDS } from '../helpers/admin-tags-page.mjs';

test('every old-form control writes exactly its own field (oracle from the old form, payload delta per control)', async t => {
  const declared = new Map();
  const driven = [];
  const displayOnly = [];
  // Two starting points, so every control is enabled in one: server cache on, then off.
  for (const serverMode of [true, false]) {
    const h = setup(t, { config: { NativePosterTagsEnabled: true, TagStylesEnabled: true, TagCacheServerMode: serverMode, StatusTagsEnabled: true } });
    await h.settle(); await h.settle();
    for (const s of h.A.sections) for (const f of s.fields || []) declared.set(f.id, f.key);
    for (const [id, key] of Object.entries(OLD_FORM.fields)) {
      assert.equal(declared.get(id), key, `${id} is declared for ${key}, as on the old form`);
      if (driven.includes(id)) continue;
      const before = structuredClone(h.server);
      const count = h.patches.length;
      let expected;
      if (id === 'customTagRules') {
        h.$('#customTagRuleAdd').click();
        h.$('.je-ct-value input').value = 'Remaster'; h.$('.je-ct-value input').dispatchEvent(new h.window.Event('input', { bubbles: true }));
        h.$('.je-ct-label input').value = 'Remaster'; h.$('.je-ct-label input').dispatchEvent(new h.window.Event('input', { bubbles: true }));
        expected = [{ Match: 'tag', Value: 'Remaster', Label: 'Remaster', Icon: null }];
      } else if (POSITION_GROUPS[id]) {
        if (!serverMode) continue;
        h.$(`.je-ta-lrow[data-group="${POSITION_GROUPS[id]}"] .je-ta-anchor[data-slot="bc"]`).click();
        expected = 'bottom-center';
      } else {
        const el = h.$(`[data-je-setting-id="${id}"]`);
        assert.ok(el, `${id} is on the page`);
        assert.equal(el.dataset.jeField, key, `${id} is bound to ${key}`);
        const inputs = el.matches('input, select, textarea') ? [el] : [...el.querySelectorAll('input')];
        if (inputs.every((i) => i.disabled) || el.closest('[data-field-row]')?.hidden) continue;
        if (el.type === 'checkbox') { expected = !el.checked; h.change(el, expected); }
        else if (el.tagName === 'SELECT') { expected = [...el.options].find((o) => o.value !== el.value && !o.disabled).value; h.change(el, expected); }
        else if (el.type === 'number') { expected = Number(el.value) >= Number(el.max) ? Number(el.value) - 1 : Number(el.value) + 1; h.change(el, String(expected)); }
        else if (el.tagName === 'TEXTAREA' || el.type === 'text' || el.type === 'password') { h.change(el, `  ${id}  `); expected = id; }
        else { const radio = inputs.find((r) => !r.checked); expected = radio.value; h.change(radio, true); }
      }
      await h.ctx.flush();
      assert.equal(h.patches.length, count + 1, `${id}: one save`);
      const delta = h.patches.at(-1).Changes;
      assert.deepEqual(Object.keys(delta).sort(), [key, ...(ALSO_WRITES[id] || [])].sort(), `${id} changes exactly ${key}`);
      assert.equal((id === 'customTagRules' ? JSON.stringify(delta[key]) : String(delta[key])), (id === 'customTagRules' ? JSON.stringify(expected) : String(expected)), `${id} saves the value chosen`);
      for (const other of Object.keys(before)) if (other !== key && !(ALSO_WRITES[id] || []).includes(other)) assert.deepEqual(h.server[other], before[other], `${id} leaves ${other} alone`);
      driven.push(id);
      // Restore only switches that gate later controls. Independent switches need
      // no second PATCH: their changed value is already covered by the delta oracle.
      const el = h.$(`[data-je-setting-id="${id}"]`);
      if (el?.type === 'checkbox' && /(?:TagsEnabled|CacheServerMode|PosterTagsEnabled|StylesEnabled)$/.test(key)) { h.change(el, !expected); await h.ctx.flush(); }
    }
  }
  for (const id of Object.keys(OLD_FORM.fields)) if (!driven.includes(id)) displayOnly.push(id);
  // Shown but not editable on its own: the browser cache follows the server cache switch.
  assert.deepEqual(displayOnly, ['enableTagsLocalStorageFallback']);
  assert.equal(driven.length, Object.keys(OLD_FORM.fields).length - 1);
  // Ids the old form bound with custom code, or actions: each still has its control.
  assert.deepEqual(OLD_FORM.unmapped, ['ratingTagsSources', 'tagLayout', 'tagShapeLandscapeDefault', 'tagShapeListDefault', 'tagLookRulesJson', 'clearTagsCacheBtn', 'tagStyleResetAll', 'rebuildTagCacheBtn']);
});


test('the page writes only the fields its sections declare, the list the server allows', async t => {
  const h = setup(t);
  assert.deepEqual(plain([...h.A.pageFields()].sort()), PAGE_FIELDS);
  // Every old-form field is one of them.
  for (const key of Object.values(OLD_FORM.fields)) assert.ok(PAGE_FIELDS.includes(key), key);
  // A section writing a field it did not declare: refused here, before the server would refuse it.
  h.expectConsoleError(/does not declare TMDB_API_KEY/);
  h.ctx.setMany({ TMDB_API_KEY: 'other', TagsHideOnHover: true });
  await h.save();
  assert.deepEqual(h.patches.map((p) => p.Changes), [{ TagsHideOnHover: true }]);
  assert.equal(h.server.TMDB_API_KEY, 'key');
});


test('tabs follow the WAI pattern and deep links open a tab and a group', async t => {
  const h = setup(t, { url: 'http://jellyfin.test/web/index.html#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups&group=rating' });
  assert.equal(h.root.dataset.tab, 'groups');
  assert.equal(h.$('.je-ta-grow[data-group="rating"]').dataset.open, 'true');
  assert.equal(h.$('#jeTaGroup-rating').hidden, false);
  assert.equal(h.$('#jeTaGroup-quality').hidden, true);
  const tab = h.$('#jeTaTab-groups');
  tab.focus();
  tab.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(h.root.dataset.tab, 'rules');
  assert.equal(h.document.activeElement, h.$('#jeTaTab-rules'));
  assert.equal(h.$('#jeTaPanel-groups').hidden, true);
  h.$('#jeTaTab-rules').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(h.root.dataset.tab, 'server');
  assert.deepEqual(h.$$('[role="tab"]').map((t) => t.tabIndex), [-1, -1, -1, -1, -1, -1, 0]);
  // data-je-goto links: Overview's group chips, the Status row's way to its badges.
  h.$('#jeTaTab-groups').click();
  h.$('#jeTaGroup-status [data-je-goto="badges"]').click();
  assert.equal(h.root.dataset.tab, 'badges');
});

test('Overview shows the defaults, the cache state, and rebuilds after a confirmation', async t => {
  const h = setup(t, { config: { TagLookRules: [{ Enabled: true, When: [{ Field: 'type', Value: 'Episode' }], Layout: 'bands', Density: 'compact' }] } });
  await h.settle();
  const groups = h.$$('.je-ta-ov-group');
  assert.deepEqual(groups.map((b) => [b.dataset.group, b.dataset.on]), [['quality', 'true'], ['genre', 'false'], ['language', 'true'], ['rating', 'true'], ['ageRating', 'false'], ['status', 'true'], ['awards', 'false'], ['logos', 'false'], ['custom', 'false'], ['people', 'false']]);
  assert.match(h.$('[data-ov="cache"]').textContent, /1,234|1234/);
  assert.match(h.$('[data-ov="look"]').textContent, /admin_tags_overview_rules_n:1/);
  groups[3].click();
  assert.equal(h.root.dataset.tab, 'groups');
  assert.equal(h.$('.je-ta-grow[data-group="rating"]').dataset.open, 'true');
  h.$('#jeTaTab-overview').click();
  h.$('[data-ov="rebuild"]').click();
  await h.settle(); await h.settle();
  assert.deepEqual(h.confirms, ['admin_tags_rebuild_title']);
  assert.deepEqual(h.posts, ['/JellyfinEnhanced/tag-cache/rebuild']);
});

test('Layout defaults: tiles, density, order, limits, nine anchors and per-layout slots write the old fields', async t => {
  const h = setup(t);
  h.change(h.$('input[name="jeTaLayout"][value="bands"]'), true);
  await h.save();
  assert.equal(h.server.TagLayout, 'bands');
  h.change([...h.$$('#tagLabelDensity input')].find((r) => r.value === 'compact'), true);
  await h.save();
  assert.equal(h.server.TagLabelDensity, 'compact');
  // Bands: a slot pick is stored as an explicit profile entry.
  h.$('.je-ta-lrow[data-group="genre"] [data-slot="top"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLayouts.Bands), { Groups: [{ Group: 'genre', Slot: 'top' }] });
  assert.equal(h.server.TagLayouts.Corners, null);
  // Order: only written once changed, as a complete list.
  h.$('.je-ta-lrow[data-group="quality"] [data-act="move"][data-dir="-1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagGroupOrder), ['quality', 'status', 'rating', 'ageRating', 'language', 'genre', 'awards', 'logos', 'custom']);
  assert.equal(h.document.activeElement?.dataset.act, 'move', 'focus stays on the move button');
  // Limits: genre 3 → 4; fixed groups have no stepper.
  h.$('.je-ta-lrow[data-group="genre"] [data-act="cap"][data-dir="1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagGroupCaps), { Genre: 4 });
  assert.equal(h.$('.je-ta-lrow[data-group="status"] [data-act="cap"]'), null);
  // Corners: an anchor writes the old position setting; Hidden is the only stored corners entry.
  h.change(h.$('input[name="jeTaLayout"][value="corners"]'), true);
  h.$('.je-ta-lrow[data-group="genre"] .je-ta-anchor[data-slot="bc"]').click();
  await h.save();
  assert.equal(h.server.GenreTagsPosition, 'bottom-center');
  h.$('.je-ta-lrow[data-group="genre"] [data-slot="off"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLayouts.Corners), { Groups: [{ Group: 'genre', Slot: 'off' }] });
  assert.equal(h.server.GenreTagsPosition, 'bottom-center', 'Hidden keeps the position for later');
  h.$('.je-ta-lrow[data-group="genre"] .je-ta-anchor[data-slot="tl"]').click();
  await h.save();
  assert.equal(h.server.TagLayouts.Corners, null, 'a corner pick shows the group again');
  assert.equal(h.server.GenreTagsPosition, 'top-left');
});

test('Layout defaults: card shapes write the recommended look, keep a custom one and inherit with null', async t => {
  const custom = { Layout: 'summary', Density: 'full', Slots: [{ Group: 'rating', Slot: 'pill' }], Caps: { Rating: 1 } };
  const h = setup(t, { config: { TagShapeOverrides: { Landscape: custom, List: null } } });
  const L = h.JE.core.tagLayout;
  assert.equal(h.$('#tagShapeLandscapeDefault').value, 'custom');
  assert.equal(h.$('#tagShapeListDefault').value, 'inherit');
  assert.equal(h.$('#tagShapeListDefault option[value="custom"]').hidden, true);
  h.change(h.$('#tagShapeListDefault'), 'recommended');
  await h.save();
  assert.deepEqual(plain(h.server.TagShapeOverrides.Landscape), custom, 'the custom look is kept untouched');
  assert.deepEqual(plain(L.readShapeOverrides(h.server.TagShapeOverrides).list), plain(L.readShapeOverrides(L.RECOMMENDED_SHAPES).list));
  assert.equal(h.server.TagShapeOverrides.List.Caps.Quality, 2);
  h.change(h.$('#tagShapeLandscapeDefault'), 'inherit');
  h.change(h.$('#tagShapeListDefault'), 'inherit');
  await h.save();
  assert.equal(h.server.TagShapeOverrides, null);
});

test('Layout defaults: Apply defaults to all users saves first, then asks the server to copy them', async t => {
  const h = setup(t);
  h.change(h.$('#tagsHideOnHover'), true);
  h.$('#jeTaApplyAll').click();
  await h.settle(); await h.settle(); await h.settle();
  assert.deepEqual(h.confirms, ['admin_tags_apply_all']);
  assert.equal(h.server.TagsHideOnHover, true, 'pending changes are saved before the copy');
  assert.deepEqual(h.posts, ['/JellyfinEnhanced/reset-all-users-settings']);
});


test('a new user\'s preview document carries every tag setting the server seeds from the configuration', () => {
  // Lexical cross-check against LoadUserSettingsDocument: every tag setting it copies
  // straight from the configuration must reach the preview's seeded document.
  const controller = readFileSync(resolve(jsRoot, '../Controllers/JellyfinEnhancedController.cs'), 'utf8');
  const block = controller.slice(controller.indexOf('var defaultUserSettings = new JellyfinEnhancedUserSettings'), controller.indexOf('TagLayoutRules.ApplyDefaults(defaultUserSettings'));
  const copied = [...block.matchAll(/(\w+) = (?:[\w.]+\()?defaultConfig\.(\w+)/g)].map((m) => m[2]).filter((k) => /Tag|Rating|Quality|Language|Status|Aggregation|^Show(Resolution|Source|Edition|LowQuality|DynamicRange|SpecialFormat|VideoCodec|AudioInfo)/.test(k));
  const h = createHarness({ JE: {} });
  try {
    h.load('enhanced/admintags/admin-tags.js');
    const seeded = h.JE.adminTags.SEEDED_KEYS;
    for (const key of copied) if (!['ShowAudioLanguages', 'DefaultLanguage'].includes(key)) assert.ok(seeded.includes(key), `${key} is seeded`);
    const user = h.JE.adminTags.seedUser({ QualityTagsEnabled: true, TagLayout: 'bands', TagGroupCaps: { Genre: 2 } });
    assert.deepEqual(plain(user), { qualityTagsEnabled: true, tagLayout: 'bands', tagGroupCaps: { Genre: 2 }, tagLayoutSettingsVersion: 1, tagStylePreset: null, useNativePosterTags: null });
  } finally { h.close(); }
});

test('the hub preview draws a supplied document and hands the signed-in user\'s settings back', t => {
  const h = setup(t, { config: { GenreTagsEnabled: false } });
  const own = h.JE.currentSettings;
  const plugin = h.JE.pluginConfig;
  h.load('enhanced/settingspanel/ui-panel-tag-preview.js');
  const mount = h.document.createElement('div');
  h.root.appendChild(mount);
  const seed = { ...h.A.seedUser(h.ctx.config), qualityTagsEnabled: true };
  const preview = h.JE.internals.enhancedUi.createTagPreview(mount, { source: () => ({ settings: seed, plugin: h.ctx.config }) });
  assert.equal(h.JE.currentSettings, own, 'the user\'s settings are back after drawing');
  assert.equal(h.JE.pluginConfig, plugin);
  assert.ok(mount.querySelector('[data-sample="movie"] .quality-overlay-container'), 'drawn from the supplied document');
  assert.equal(mount.querySelector('[data-sample="movie"] .genre-overlay-container'), null);
  assert.match(h.document.getElementById('je-tag-preview').textContent, /:is\(#jellyfin-enhanced-panel, \.je-tag-admin\) \.je-mtp-samples/);
  preview.dispose();
});


test('What\'s New on the main page lists new Media Tags settings with a link to their tab', () => {
  // configPage.html's own helpers, run as the page runs them.
  const page = readFileSync(resolve(jsRoot, '../Configuration/configPage.html'), 'utf8');
  const humanize = /function jeHumanizeSettingId\(id\) \{[\s\S]*?\n        \}/.exec(page)[0];
  const helper = page.slice(page.indexOf('// jeMediaTagsWhatsNewEntries: begin'), page.indexOf('// jeMediaTagsWhatsNewEntries: end'));
  assert.ok(helper.includes('function jeMediaTagsWhatsNewEntries'));
  const h = createHarness({ JE: {} });
  try {
    h.window.eval(`${humanize}\n${helper}\nwindow.entries = jeMediaTagsWhatsNewEntries;`);
    const names = { admin_tags_title: 'Media Tags', admin_tags_tab_layout: 'Layout defaults', admin_tags_tab_groups: 'Groups', admin_tags_tab_badges: 'Status badges', panel_settings_ui_tag_group_rating: 'Rating', panel_settings_ui_tag_group_age_rating: 'Age Rating' };
    const t = (key) => names[key] || key;
    const where = {
      tagLayout: { page: 'JellyfinEnhancedMediaTags', tab: 'layout', group: null },
      tagsHideOnHover: { page: 'JellyfinEnhancedMediaTags', tab: 'layout', group: null },
      ratingTagsOnNextUp: { page: 'JellyfinEnhancedMediaTags', tab: 'groups', group: 'rating' },
      ageRatingTagsEnabled: { page: 'JellyfinEnhancedMediaTags', tab: 'groups', group: 'ageRating' },
      // A setting new in a later release, on a tab this build has no name for.
      tagFutureThing: { page: 'JellyfinEnhancedMediaTags', tab: 'extras', group: null },
    };
    const entries = plain(h.window.entries(Object.keys(where).concat('notOnAnyPage'), where, t));
    assert.deepEqual(entries, [
      { tab: 'layout', tabLabel: 'Media Tags', title: 'Layout defaults', href: '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=layout', ids: ['tagLayout', 'tagsHideOnHover'] },
      { tab: 'groups', tabLabel: 'Media Tags', title: 'Groups › Rating', href: '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups&group=rating', ids: ['ratingTagsOnNextUp'] },
      { tab: 'groups', tabLabel: 'Media Tags', title: 'Groups › Age Rating', href: '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups&group=ageRating', ids: ['ageRatingTagsEnabled'] },
      { tab: 'extras', tabLabel: 'Media Tags', title: 'Extras', href: '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=extras', ids: ['tagFutureThing'] },
    ]);
    // Without the client bundle the names fall back to English.
    assert.equal(plain(h.window.entries(['ratingTagsOnNextUp'], where, null))[0].title, 'Groups › Rating');
  } finally { h.close(); }
  // checkWhatsNew routes the ids the main page has no control for through it, and the chip follows the link.
  assert.match(page, /var movedEntries = jeMediaTagsWhatsNewEntries\(moved, mediaTags,/);
  assert.match(page, /renderWhatsNewBanner\(\(perSetting\.length \? groupWhatsNewByFieldset\(perSetting\) : \[\]\)\.concat\(movedEntries\)/);
  assert.match(page, /if \(f\.href\) window\.location\.href = f\.href;/);
});


for (const maximum of [1, 2]) test(`admin layout and Groups omit single-chip steppers with maximum ${maximum}`, async t => {
  const h = setup(t, { config: { LogoTagsMaxLogos: maximum } });
  await h.settle();
  for (const group of ['status', 'ageRating', 'logos', 'quality', 'genre', 'language', 'rating', 'awards', 'custom']) {
    const fixed = ['status', 'ageRating'].includes(group) || (group === 'logos' && maximum === 1);
    assert.equal(!!h.$(`.je-ta-lrow[data-group="${group}"] [data-act="cap"]`), !fixed, group);
  }
});


test('editing Genre cap carries stored single-chip limits through the admin layout editor', async t => {
  const h = setup(t, { config: { TagGroupCaps: { Status: 9, AgeRating: 0, Genre: 2 } } });
  h.$('.je-ta-lrow[data-group="genre"] [data-act="cap"][data-dir="1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagGroupCaps), { Status: 9, AgeRating: 0, Genre: 3 });
});

