import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, plain, jsRoot } from '../helpers/harness.mjs';

/** The administrator's rules as the public configuration serves them (PascalCase, normalised). */
const RULES = [
  { Match: 'collection', Value: 'Criterion', Label: 'Criterion', Icon: null },
  { Match: 'tag', Value: '4K Remaster', Label: 'Remaster', Icon: 'auto_awesome' },
  { Match: 'tag', Value: 'Signed', Label: 'Signed', Icon: null },
  { Match: 'tag', Value: 'Director Approved', Label: 'Approved', Icon: null },
];
const ALL = ['collection:criterion', 'tag:4k remaster', 'tag:signed', 'tag:director approved'];

/**
 * The real Custom renderer over the real layout controller on one card.
 * @param {import('node:test').TestContext} t
 * @param {object} [settings]
 * @param {object} [plugin]
 */
function setup(t, settings = {}, plugin = {}) {
  const renderers = new Map();
  const store = new Map();
  const h = createHarness({ html: '<div class="card" data-type="Movie" data-id="item"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Title</div></div></div>',
    JE: { currentSettings: { customTagsEnabled: true, ...settings }, pluginConfig: { CustomTagRules: RULES, TagCacheServerMode: false, ...plugin },
      t: (key, params) => (params ? `${key}:${params.name}` : key),
      tagPipeline: { registerRenderer: (id, renderer) => renderers.set(id, renderer), getRenderer: id => renderers.get(id), clearProcessed() {}, scheduleScan() {} } },
    globals: { localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key), key: () => null, length: 0 } } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/customtags.js']) h.load(file);
  h.JE.initializeCustomTags();
  const host = h.document.querySelector('.je-tag-host');
  const renderer = () => renderers.get('custom');
  return { ...h, host, renderer,
    render(entry) { renderer().renderFromServerCache(host, entry, 'item'); },
    batch(item) { renderer().render(host, { Id: 'item', Type: 'Movie', ...item }, {}); },
    chips: () => [...host.querySelectorAll('.custom-tag')].filter(el => !el.closest('[data-je-slot="hover"]')),
    labels() { return this.chips().map(el => el.dataset.jeCustom); } };
}

test('chips follow the server\'s rule order, carry the label, the optional icon and a two-line tooltip', t => {
  const h = setup(t);
  h.render({ Type: 'Movie', CustomTags: ['tag:4k remaster', 'tag:gone', 'collection:criterion', 'tag:4k remaster'] });
  assert.deepEqual(h.labels(), ['Remaster', 'Criterion'], 'ids without a rule are skipped, repeats drawn once');
  const [remaster, criterion] = h.chips();
  assert.equal(remaster.querySelector('.custom-tag-icon').textContent, 'auto_awesome');
  assert.equal(remaster.querySelector('.custom-tag-icon').getAttribute('aria-hidden'), 'true');
  assert.equal(remaster.querySelector('.custom-tag-text').textContent, 'Remaster');
  assert.equal(remaster.title, 'Remaster\ncustom_tags_source_tag:4K Remaster');
  assert.equal(criterion.querySelector('.custom-tag-icon'), null);
  assert.equal(criterion.title, 'Criterion\ncustom_tags_source_collection:Criterion');
  assert.equal(criterion.dataset.jeCustomRule, 'collection:criterion');
  // Corners by default: the top-left stack, in the frozen group wrapper.
  assert.equal(h.host.querySelector('.custom-overlay-container').closest('[data-je-slot]').dataset.jeSlot, 'tl');
  assert.equal(h.host.querySelector('.custom-overlay-container').dataset.jeGroup, 'custom');
});

test('an entry without matches, or with only retired rules, draws nothing', t => {
  const h = setup(t);
  h.render({ Type: 'Movie' });
  h.render({ Type: 'Movie', CustomTags: ['tag:retired'] });
  assert.equal(h.host.querySelector('.custom-overlay-container'), null);
});

test('the cap keeps the first chips: three by default, the user\'s cap, or all', t => {
  const h = setup(t);
  h.render({ Type: 'Movie', CustomTags: ALL });
  assert.deepEqual(h.labels(), ['Criterion', 'Remaster', 'Signed'], 'the built-in cap is three');

  const one = setup(t, { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagGroupCaps: { custom: 1 } });
  one.render({ Type: 'Movie', CustomTags: ALL });
  assert.deepEqual(one.labels(), ['Criterion']);

  const all = setup(t, { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagGroupCaps: { custom: 0 } });
  all.render({ Type: 'Movie', CustomTags: ALL });
  assert.deepEqual(all.labels(), ['Criterion', 'Remaster', 'Signed', 'Approved']);
});

test('the other layouts place the group in their slots and the summary pill states the first label', t => {
  const bands = setup(t, { tagLayoutSettingsVersion: 1, tagLayout: 'bands' });
  bands.render({ Type: 'Movie', CustomTags: ALL });
  assert.equal(bands.host.querySelector('.custom-tag').closest('[data-je-slot]').dataset.jeSlot, 'bottom');

  const caption = setup(t, { tagLayoutSettingsVersion: 1, tagLayout: 'caption' });
  caption.render({ Type: 'Movie', CustomTags: ALL });
  assert.ok(caption.document.querySelector('.je-tag-caption .custom-tag'), 'the strip below the image');

  const summary = setup(t, { tagLayoutSettingsVersion: 1, tagLayout: 'summary', tagLayouts: { summary: { groups: [{ group: 'custom', slot: 'pill' }] } } });
  summary.render({ Type: 'Movie', CustomTags: ALL });
  assert.equal(summary.host.querySelector('.je-tag-pill').textContent, 'Criterion', 'the label, never the icon ligature');

  const hover = setup(t, { tagLayoutSettingsVersion: 1, tagLayout: 'minimal' });
  hover.render({ Type: 'Movie', CustomTags: ['tag:4k remaster'] });
  assert.ok(hover.host.querySelector('[data-je-slot="hover"] .custom-tag'), 'full chips on hover in minimal');

  const off = setup(t, { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagLayouts: { corners: { groups: [{ group: 'custom', slot: 'off' }] } } });
  off.render({ Type: 'Movie', CustomTags: ALL });
  assert.equal(off.host.querySelector('.custom-tag'), null);
});

test('the priority order places custom chips relative to the other groups in a shared corner', t => {
  const h = setup(t, { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagGroupOrder: ['custom', 'status'], ageRatingTagsEnabled: true, ageRatingTagsPosition: 'top-left' });
  h.load('tags/ageratingtags.js');
  h.JE.cdn = { url: () => 'about:blank' };
  h.JE.normalizeOfficialRating = value => value;
  const age = h.document.createElement('div');
  age.className = 'age-rating-overlay-container';
  age.innerHTML = '<div class="age-rating-tag" rating="PG">PG</div>';
  h.JE.core.tagLayout.commitGroup(h.host, 'agerating', age);
  h.render({ Type: 'Movie', CustomTags: ['tag:signed'] });
  const stack = h.host.querySelector('[data-je-slot="tl"]');
  assert.deepEqual([...stack.children].map(el => el.dataset.jeGroup), ['custom', 'ageRating']);
});

test('the batch fallback keeps per-item matches only while the rules stay the same', t => {
  const h = setup(t);
  h.batch({ CustomTags: ['tag:signed'] });
  assert.deepEqual(h.labels(), ['Signed']);
  h.JE.core.tagLayout.removeGroup(h.host, 'custom');
  delete h.document.querySelector('.card').dataset.jeCustomTagged;
  assert.equal(h.renderer().renderFromCache(h.host, 'item'), true, 'a cache hit');
  assert.deepEqual(h.labels(), ['Signed']);

  // An item without a match is remembered too: nothing to fetch.
  h.renderer().render(h.host, { Id: 'other', Type: 'Movie' }, {});
  assert.equal(h.renderer().renderFromCache(h.host, 'other'), true);

  // A rule added since may match the item: the stored match is not trusted.
  h.JE.pluginConfig = { ...h.JE.pluginConfig, CustomTagRules: RULES.concat({ Match: 'tag', Value: 'New', Label: 'New', Icon: null }) };
  h.JE.reinitializeCustomTags();
  assert.equal(h.renderer().renderFromCache(h.host, 'item'), false);
});

test('a label or icon edit applies to drawn rule ids at once, without new matches', t => {
  const h = setup(t);
  h.JE.pluginConfig = { ...h.JE.pluginConfig, CustomTagRules: [{ Match: 'tag', Value: 'SIGNED', Label: 'Autographed', Icon: 'favorite' }] };
  h.JE.reinitializeCustomTags();
  h.render({ Type: 'Movie', CustomTags: ['tag:signed'] });
  assert.deepEqual(h.labels(), ['Autographed']);
  assert.equal(h.host.querySelector('.custom-tag-icon').textContent, 'favorite');
});

test('an icon outside the bundled genre set is never drawn (it would render as a word)', t => {
  const h = setup(t, {}, { CustomTagRules: [{ Match: 'tag', Value: 'Signed', Label: 'Signed', Icon: 'not_in_subset' }] });
  h.render({ Type: 'Movie', CustomTags: ['tag:signed'] });
  assert.equal(h.host.querySelector('.custom-tag-icon'), null);
});

test('Tag Styles colour every custom chip and each label', t => {
  const h = setup(t);
  h.load('tags/tag-styles.js');
  const css = h.JE.tagStyles.buildCss({ custom: { '*': { background: 'rgba(1, 2, 3, 1)' }, 'Re"mas\\ter': { color: 'rgba(4, 5, 6, 1)' } } });
  assert.match(css, /\.custom-overlay-container\.custom-overlay-container \.custom-tag \{ background-color: rgba\(1, 2, 3, 1\) !important; \}/);
  assert.match(css, /\.custom-tag\[data-je-custom="Re\\"mas\\\\ter"\] \{ color: rgba\(4, 5, 6, 1\) !important; \}/);
  assert.equal(h.JE.tagStyles.buildCss({ custom: { Bad: { color: 'red; } body { x' } } }), '', 'only colours reach the sheet');
});

test('the icon list is the bundled genre icon set, the same on the server and the configuration page', () => {
  const genre = readFileSync(`${jsRoot}/tags/genretags.js`, 'utf8');
  const map = genre.slice(genre.indexOf('const genreIconMap = {'), genre.indexOf('};', genre.indexOf('const genreIconMap = {')));
  const genreIcons = [...new Set([...map.matchAll(/:\s*'([a-z_]+)'/g)].map(m => m[1]))].sort();
  const list = source => JSON.parse(`[${/ICONS = \[([^\]]+)\]/.exec(source)[1].replace(/'/g, '"')}]`).sort();
  assert.deepEqual(list(readFileSync(`${jsRoot}/tags/customtags.js`, 'utf8')), genreIcons);
  assert.deepEqual(list(readFileSync(`${jsRoot}/../Configuration/configPage.html`, 'utf8').slice(readFileSync(`${jsRoot}/../Configuration/configPage.html`, 'utf8').indexOf('var customTagRules = (function'))), genreIcons);
  const server = readFileSync(`${jsRoot}/../Configuration/CustomTagRuleSet.cs`, 'utf8');
  const cs = JSON.parse(`[${/Icons = new\[\]\s*\{([^}]+)\}/.exec(server)[1].replace(/,\s*$/, '')}]`).sort();
  assert.deepEqual(cs, genreIcons);
});

test('the layout controller knows the group: defaults, recommended shape looks and its wrapper class', t => {
  const h = setup(t);
  const L = h.JE.core.tagLayout;
  assert.equal(L.DEFAULT_ORDER.at(-1), 'custom', 'last in the default order');
  assert.equal(L.CONTAINER_CLASS.custom, 'custom-overlay-container');
  assert.equal(L.POSITION_SETTINGS.custom.fallback, 'top-left');
  const s = L.normalizeSettings();
  assert.equal(s.caps.custom, 3);
  assert.deepEqual(plain({ bands: s.profiles.bands.custom, caption: s.profiles.caption.custom, summary: s.profiles.summary.custom, minimal: s.profiles.minimal.custom }),
    { bands: 'bottom', caption: 'caption', summary: 'hover', minimal: 'hover' });
  assert.equal(L.RECOMMENDED_SHAPES.landscape.slots.custom, 'off');
  assert.equal(L.RECOMMENDED_SHAPES.list.slots.custom, 'off');
});
