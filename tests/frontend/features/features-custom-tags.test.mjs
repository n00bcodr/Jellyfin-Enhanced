import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, plain, jsRoot } from '../helpers/harness.mjs';

/** Opaque rule ids, as the server derives them (a keyed hash of the match type and value). */
const ID = { criterion: 'collection:9f2c1e0b7a6d5c4e', remaster: 'tag:1a2b3c4d5e6f7081', signed: 'tag:aa11bb22cc33dd44', approved: 'tag:0f0e0d0c0b0a0908' };
/** The administrator's rules as the public configuration serves them: ids, labels and icons only. */
const RULES = [
  { Id: ID.criterion, Label: 'Criterion', Icon: null },
  { Id: ID.remaster, Label: 'Remaster', Icon: 'auto_awesome' },
  { Id: ID.signed, Label: 'Signed', Icon: null },
  { Id: ID.approved, Label: 'Approved', Icon: null },
];
/** What each rule matches, from the private configuration only administrators receive. */
const SOURCES = [
  { Id: ID.criterion, Match: 'collection', Value: 'Criterion' },
  { Id: ID.remaster, Match: 'tag', Value: '4K Remaster' },
  { Id: ID.signed, Match: 'tag', Value: 'Signed' },
  { Id: ID.approved, Match: 'tag', Value: 'Director Approved' },
];
const ALL = [ID.criterion, ID.remaster, ID.signed, ID.approved];
/** Render extras of a /tag-data answer for a user Spoiler Guard strips nothing for. */
const UNSTRIPPED = { stripRevision: 'none' };

/**
 * The real Custom renderer over the real layout controller on one card.
 * @param {import('node:test').TestContext} t
 * @param {object} [settings]
 * @param {object} [plugin]
 */
function setup(t, settings = {}, plugin = {}) {
  const renderers = new Map();
  const store = new Map();
  const pipeline = { strip: 'none' };
  const h = createHarness({ html: '<div class="card" data-type="Movie" data-id="item"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Title</div></div></div>',
    JE: { currentSettings: { customTagsEnabled: true, ...settings }, pluginConfig: { CustomTagRules: RULES, TagCacheServerMode: false, ...plugin },
      t: (key, params) => (params ? `${key}:${params.name}` : key),
      tagPipeline: { registerRenderer: (id, renderer) => renderers.set(id, renderer), getRenderer: id => renderers.get(id), clearProcessed() {}, scheduleScan() {}, tagStripRevision: () => pipeline.strip } },
    globals: { localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key), key: () => null, length: 0 } } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/customtags.js']) h.load(file);
  h.JE.initializeCustomTags();
  const host = h.document.querySelector('.je-tag-host');
  const renderer = () => renderers.get('custom');
  return { ...h, host, renderer, pipeline,
    render(entry) { renderer().renderFromServerCache(host, entry, 'item'); },
    batch(item) { renderer().render(host, { Id: 'item', Type: 'Movie', ...item }, UNSTRIPPED); },
    chips: () => [...host.querySelectorAll('.custom-tag')].filter(el => !el.closest('[data-je-slot="hover"]')),
    labels() { return this.chips().map(el => el.dataset.jeCustom); } };
}

test('chips carry the label, the optional icon and, for administrators, a two-line tooltip', t => {
  const h = setup(t, {}, { CustomTagRuleSources: SOURCES });
  h.render({ Type: 'Movie', CustomTags: [ID.criterion, 'tag:gone', ID.remaster, ID.criterion] });
  assert.deepEqual(h.labels(), ['Criterion', 'Remaster'], 'ids without a rule are skipped, repeats drawn once');
  const [criterion, remaster] = h.chips();
  assert.equal(remaster.querySelector('.custom-tag-icon').textContent, 'auto_awesome');
  assert.equal(remaster.querySelector('.custom-tag-icon').getAttribute('aria-hidden'), 'true');
  assert.equal(remaster.querySelector('.custom-tag-text').textContent, 'Remaster');
  assert.equal(remaster.title, 'Remaster\ncustom_tags_source_tag:4K Remaster');
  assert.equal(criterion.querySelector('.custom-tag-icon'), null);
  assert.equal(criterion.title, 'Criterion\ncustom_tags_source_collection:Criterion');
  assert.equal(criterion.dataset.jeCustomRule, ID.criterion);
  // Corners by default: the top-left stack, in the frozen group wrapper.
  assert.equal(h.host.querySelector('.custom-overlay-container').closest('[data-je-slot]').dataset.jeSlot, 'tl');
  assert.equal(h.host.querySelector('.custom-overlay-container').dataset.jeGroup, 'custom');
});

test('without the private configuration (non-administrators) nothing names what a rule matches', t => {
  const h = setup(t);
  h.render({ Type: 'Movie', CustomTags: [ID.criterion, ID.remaster] });
  assert.deepEqual(h.chips().map(el => el.title), ['Criterion', 'Remaster'], 'the label only');
  const markup = h.host.innerHTML + JSON.stringify(h.JE.customTags.currentRules().rules.get(ID.criterion));
  for (const name of ['4K Remaster', 'custom_tags_source']) assert.ok(!markup.includes(name), name);
  assert.deepEqual(plain(h.JE.customTags.currentRules().rules.get(ID.criterion)), { id: ID.criterion, label: 'Criterion', icon: null, match: null, value: null });
});

test('chips follow the current rule order, whatever order the cached ids were stored in', t => {
  const h = setup(t, { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagGroupCaps: { custom: 1 } });
  // Stored before a reorder: Signed first.
  const stored = { Type: 'Movie', CustomTags: [ID.signed, ID.criterion] };
  h.render(stored);
  assert.deepEqual(h.labels(), ['Criterion'], 'the cap keeps the first rule in the table');

  // The administrator moves Signed to the top: the same stored ids now draw Signed first.
  h.JE.pluginConfig = { ...h.JE.pluginConfig, CustomTagRules: [RULES[2], RULES[0], RULES[1], RULES[3]] };
  h.JE.reinitializeCustomTags();
  h.JE.core.tagLayout.removeGroup(h.host, 'custom');
  delete h.document.querySelector('.card').dataset.jeCustomTagged;
  h.render(stored);
  assert.deepEqual(h.labels(), ['Signed']);
  assert.deepEqual(plain(h.JE.customTags.rulesFor([ID.criterion, ID.signed]).map(r => r.label)), ['Signed', 'Criterion'], 'cache and batch data draw alike');
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
  hover.render({ Type: 'Movie', CustomTags: [ID.remaster] });
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
  h.render({ Type: 'Movie', CustomTags: [ID.signed] });
  const stack = h.host.querySelector('[data-je-slot="tl"]');
  assert.deepEqual([...stack.children].map(el => el.dataset.jeGroup), ['custom', 'ageRating']);
});

test('the batch fallback keeps per-item matches only while the rules stay the same', t => {
  const h = setup(t);
  h.batch({ CustomTags: [ID.signed] });
  assert.deepEqual(h.labels(), ['Signed']);
  h.JE.core.tagLayout.removeGroup(h.host, 'custom');
  delete h.document.querySelector('.card').dataset.jeCustomTagged;
  assert.equal(h.renderer().renderFromCache(h.host, 'item'), true, 'a cache hit');
  assert.deepEqual(h.labels(), ['Signed']);

  // An item without a match is remembered too: nothing to fetch.
  h.renderer().render(h.host, { Id: 'other', Type: 'Movie' }, UNSTRIPPED);
  assert.equal(h.renderer().renderFromCache(h.host, 'other'), true);

  // A rule added since may match the item: the stored match is not trusted.
  h.JE.pluginConfig = { ...h.JE.pluginConfig, CustomTagRules: RULES.concat({ Id: 'tag:5e5e5e5e5e5e5e5e', Label: 'New', Icon: null }) };
  h.JE.reinitializeCustomTags();
  assert.equal(h.renderer().renderFromCache(h.host, 'item'), false);
});

test('the batch fallback copies go when the server copy is replaced (access or Spoiler Guard changed)', t => {
  const h = setup(t);
  const spec = h.renderer();
  /** The card as if it had not been drawn yet. */
  const fresh = () => {
    h.JE.core.tagLayout.removeGroup(h.host, 'custom');
    delete h.document.querySelector('.card').dataset.jeCustomTagged;
  };
  const hit = id => { fresh(); return spec.renderFromCache(h.host, id); };
  spec.render(h.host, { Id: 'item', Type: 'Movie', CustomTags: [ID.signed] }, UNSTRIPPED);
  fresh();
  spec.render(h.host, { Id: 'other', Type: 'Movie', CustomTags: [ID.criterion] }, UNSTRIPPED);
  assert.equal(hit('item'), true);
  // A delta drops the items it carries; a replacement drops them all.
  spec.onServerCacheRefresh(['item']);
  assert.equal(hit('item'), false);
  assert.equal(hit('other'), true);
  spec.onServerCacheRefresh(null, { replaced: true });
  assert.equal(hit('other'), false);
});

test('a Spoiler Guard stub without matches replaces the stored ones in the batch fallback', t => {
  const h = setup(t);
  const spec = h.renderer();
  const fresh = () => {
    h.JE.core.tagLayout.removeGroup(h.host, 'custom');
    delete h.document.querySelector('.card').dataset.jeCustomTagged;
  };
  spec.render(h.host, { Id: 'item', Type: 'Episode', CustomTags: [ID.signed] }, UNSTRIPPED);
  fresh();
  // The server strips CustomTags from a guarded item's /tag-data stub, as it strips its genres.
  spec.render(h.host, { Id: 'item', Type: 'Episode', Genres: [] }, UNSTRIPPED);
  assert.deepEqual(h.labels(), []);
  fresh();
  assert.equal(spec.renderFromCache(h.host, 'item'), true, 'still a hit: nothing to fetch');
  assert.deepEqual(h.labels(), []);
});

test('a stored match is drawn only under the Spoiler Guard tag strip it was matched under', t => {
  const h = setup(t);
  const spec = h.renderer();
  const fresh = () => {
    h.JE.core.tagLayout.removeGroup(h.host, 'custom');
    delete h.document.querySelector('.card').dataset.jeCustomTagged;
  };
  const hit = id => { fresh(); return spec.renderFromCache(h.host, id); };
  spec.render(h.host, { Id: 'item', Type: 'Movie', CustomTags: [ID.signed] }, UNSTRIPPED);
  assert.equal(hit('item'), true);

  // Unknown (no bootstrap value, no answer yet): fetch, but keep the copy for when it is known.
  h.pipeline.strip = null;
  assert.equal(hit('item'), false);
  h.pipeline.strip = 'none';
  assert.equal(hit('item'), true, 'not discarded while unknown');

  // A guard set since (here or elsewhere): the copy is discarded and the item fetched again.
  h.pipeline.strip = 'g1:aaaa';
  assert.equal(hit('item'), false);
  h.pipeline.strip = 'none';
  assert.equal(hit('item'), false, 'discarded, not just skipped');

  // Under a guard, an answer is reused on this page only, never stored for the next one.
  h.pipeline.strip = 'g1:aaaa';
  spec.render(h.host, { Id: 'guarded', Type: 'Movie', CustomTags: [ID.criterion] }, { stripRevision: 'g1:aaaa' });
  assert.equal(hit('guarded'), true);
  assert.deepEqual(h.labels(), ['Criterion']);
  h.JE._hotCache.custom.clear(); // a new page: only the persistent copy is left
  assert.equal(hit('guarded'), false);
  // Neither is an item that did not come from /tag-data (the per-item fallback).
  spec.render(h.host, { Id: 'native', Type: 'Movie' }, { stripRevision: null });
  assert.equal(hit('native'), false);
});

/**
 * One page load with the server tag cache off: the real pipeline and Custom
 * renderer over a localStorage carried between pages. The bootstrap says
 * `prefetched` about the user's tag strip, and /tag-data answers `answer`.
 * @param {import('node:test').TestContext} t
 * @param {Map<string, string>} store
 * @param {{prefetched?: string, answer: object}} page
 */
async function cacheOffPage(t, store, { prefetched, answer }) {
  const movie = '0123456789abcdef0123456789abcdef';
  const idle = [], timers = new Map(), calls = [], saves = [];
  let seq = 0;
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key),
    key: i => [...store.keys()][i] ?? null, get length() { return store.size; } };
  const h = createHarness({ html: `<div class="card" data-type="Movie" data-id="${movie}"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div><div class="cardText">Title</div></div></div>`,
    JE: { currentSettings: { customTagsEnabled: true }, pluginConfig: { CustomTagRules: RULES, TagCacheServerMode: false },
      t: key => key, takePrefetched: name => (name === 'TagStripRevision' ? prefetched : undefined),
      _cacheManager: { register: fn => saves.push(fn), markDirty() {} }, helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} } },
    apiClient: { ajax: async options => { calls.push(options.url); return { Items: [{ Id: movie, Type: 'Movie', ...answer.item }], StripRevision: answer.strip }; } },
    globals: { requestIdleCallback: fn => idle.push(fn), setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: id => timers.delete(id) } });
  Object.defineProperty(h.window, 'localStorage', { value: storage, configurable: true });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/tag-pipeline.js', 'tags/customtags.js']) h.load(file);
  h.JE.initializeCustomTags();
  h.JE.tagPipeline.initialize();
  for (let n = 0; n < 8; n++) {
    await new Promise(resolve => setImmediate(resolve));
    while (idle.length) idle.shift()({ timeRemaining: () => 50, didTimeout: false });
    for (const [id, timer] of [...timers]) if (timer.ms === 150) { timers.delete(id); timer.fn(); }
  }
  for (const save of saves) save();
  return { calls, labels: [...h.document.querySelectorAll('.custom-tag')].map(el => el.dataset.jeCustom) };
}

test('with the server cache off, a match kept from an earlier page never outlives a Spoiler Guard set since', async t => {
  const store = new Map();
  const open = { item: { CustomTags: [ID.signed] }, strip: 'none' };
  const guarded = { item: { Genres: [] }, strip: 'g1:5ec2e7' };

  const first = await cacheOffPage(t, store, { prefetched: 'none', answer: open });
  assert.deepEqual(first, { calls: [first.calls[0]], labels: ['Signed'] });
  assert.match(first.calls[0], /\/tag-data\//);
  const reload = await cacheOffPage(t, store, { prefetched: 'none', answer: open });
  assert.deepEqual(reload, { calls: [], labels: ['Signed'] }, 'unguarded: drawn from the kept match, nothing fetched');

  // The movie is guarded from another client: the next page knows from the bootstrap.
  const after = await cacheOffPage(t, store, { prefetched: 'g1:5ec2e7', answer: guarded });
  assert.equal(after.calls.length, 1, 'one batch request instead of the kept match');
  assert.deepEqual(after.labels, []);
  assert.deepEqual(await cacheOffPage(t, store, { prefetched: 'g1:5ec2e7', answer: guarded }).then(p => [p.calls.length, p.labels]), [1, []],
    'guarded answers are not kept for the next page');

  // Unguarded again: the chip returns, and is kept again.
  assert.deepEqual(await cacheOffPage(t, store, { prefetched: 'none', answer: open }).then(p => [p.calls.length, p.labels]), [1, ['Signed']]);
  assert.deepEqual(await cacheOffPage(t, store, { prefetched: 'none', answer: open }).then(p => [p.calls.length, p.labels]), [0, ['Signed']]);

  // Without a bootstrap value the first answer decides: still nothing drawn from the kept copy first.
  const unknown = await cacheOffPage(t, store, { prefetched: undefined, answer: guarded });
  assert.deepEqual([unknown.calls.length, unknown.labels], [1, []]);
});

test('a label or icon edit applies to drawn rule ids at once, without new matches', t => {
  const h = setup(t);
  h.JE.pluginConfig = { ...h.JE.pluginConfig, CustomTagRules: [{ Id: ID.signed, Label: 'Autographed', Icon: 'favorite' }] };
  h.JE.reinitializeCustomTags();
  h.render({ Type: 'Movie', CustomTags: [ID.signed] });
  assert.deepEqual(h.labels(), ['Autographed']);
  assert.equal(h.host.querySelector('.custom-tag-icon').textContent, 'favorite');
});

test('an icon outside the bundled genre set is never drawn (it would render as a word)', t => {
  const h = setup(t, {}, { CustomTagRules: [{ Id: ID.signed, Label: 'Signed', Icon: 'not_in_subset' }] });
  h.render({ Type: 'Movie', CustomTags: [ID.signed] });
  assert.equal(h.host.querySelector('.custom-tag-icon'), null);
});

test('Tag Styles colour every custom chip and each label', t => {
  const h = setup(t);
  h.load('tags/tag-styles.js');
  const css = h.JE.tagStyles.buildCss({ custom: { '*': { background: 'rgba(1, 2, 3, 1)' }, 'Re"mas\\ter': { color: 'rgba(4, 5, 6, 1)' } } });
  assert.match(css.replaceAll(':where(:not([data-je-tag-styles-scope] *))', ''), /\.custom-overlay-container\.custom-overlay-container \.custom-tag \{ background-color: rgba\(1, 2, 3, 1\) !important; \}/);
  assert.match(css.replaceAll(':where(:not([data-je-tag-styles-scope] *))', ''), /\.custom-tag\[data-je-custom="Re\\"mas\\\\ter"\] \{ color: rgba\(4, 5, 6, 1\) !important; \}/);
  assert.equal(h.JE.tagStyles.buildCss({ custom: { Bad: { color: 'red; } body { x' } } }), '', 'only colours reach the sheet');
});

test('the icon list is the bundled genre icon set, the same on the server and the configuration page', () => {
  // The genre table genretags.js is generated from (scripts/generate_genre_labels.py).
  const table = JSON.parse(readFileSync(`${jsRoot}/tags/genre-icons.json`, 'utf8'));
  const genreIcons = [...new Set([table.defaultIcon, ...Object.values(table.names).flatMap(names => Object.values(names))])].sort();
  const list = source => JSON.parse(`[${/ICONS = \[([^\]]+)\]/.exec(source)[1].replace(/'/g, '"')}]`).sort();
  assert.deepEqual(list(readFileSync(`${jsRoot}/tags/customtags.js`, 'utf8')), genreIcons);
  assert.deepEqual(list(readFileSync(`${jsRoot}/enhanced/admintags/custom-rules-editor.js`, 'utf8')), genreIcons);
  const server = readFileSync(`${jsRoot}/../Configuration/CustomTagRuleSet.cs`, 'utf8');
  const cs = JSON.parse(`[${/Icons = new\[\]\s*\{([^}]+)\}/.exec(server)[1].replace(/,\s*$/, '')}]`).sort();
  assert.deepEqual(cs, genreIcons);
});

test('the rules table flags punctuation-only labels such as "*" and leaves them out of the save', t => {
  const h = createHarness();
  t.after(() => h.close());
  h.JE.adminTags = {}; h.load('enhanced/admintags/custom-rules-editor.js');
  h.document.body.innerHTML = h.JE.adminTags.CUSTOM_HTML;
  h.window.__rules = h.JE.adminTags.createCustomTagRules(h.document.body);
  const rules = h.window.__rules;
  rules.load({ CustomTagRules: [
    { Match: 'tag', Value: 'Signed', Label: '*', Icon: null },
    { Match: 'tag', Value: 'Remaster', Label: ' ?! ', Icon: null },
    { Match: 'tag', Value: 'Plus', Label: '+', Icon: null },
    { Match: 'collection', Value: 'Criterion', Label: '*Criterion*', Icon: null },
  ] });
  const labels = [...h.document.querySelectorAll('.je-ct-label input')];
  const hints = [...h.document.querySelectorAll('.je-ct-label .je-ct-hint')];
  assert.deepEqual(labels.map(el => el.getAttribute('aria-invalid')), ['true', 'true', 'false', 'false']);
  assert.deepEqual(hints.map(el => el.hidden), [false, false, true, true]);
  assert.match(hints[0].textContent, /\*/);
  assert.equal(labels[0].getAttribute('aria-describedby'), hints[0].id);
  const config = {};
  rules.collect(config);
  assert.deepEqual(plain(config.CustomTagRules.map(r => r.Label)), ['+', '*Criterion*'], 'as the server stores them');

  // Typing a real label clears the flag.
  labels[0].value = 'Signed';
  labels[0].dispatchEvent(new h.window.Event('input'));
  assert.equal(labels[0].getAttribute('aria-invalid'), 'false');
  assert.equal(hints[0].hidden, true);
});

test('the rules table classifies reserved labels by Unicode scalar value, exactly like the server', t => {
  // The same cases CustomTagRulesTests checks Normalize, IsValidLabel and Tag Styles against.
  const cases = JSON.parse(readFileSync(new URL('../../fixtures/custom-tag-labels.json', import.meta.url), 'utf8'));
  assert.ok(cases.some(c => [...c.label].length < c.label.length && !c.kept), 'covers supplementary-plane punctuation');
  const h = createHarness();
  t.after(() => h.close());
  h.JE.adminTags = {}; h.load('enhanced/admintags/custom-rules-editor.js');
  h.document.body.innerHTML = h.JE.adminTags.CUSTOM_HTML;
  h.window.__rules = h.JE.adminTags.createCustomTagRules(h.document.body);
  h.window.__rules.load({ CustomTagRules: cases.map((c, i) => ({ Match: 'tag', Value: `Tag ${i}`, Label: c.label, Icon: null })) });
  const flagged = [...h.document.querySelectorAll('.je-ct-label input')].map(el => el.getAttribute('aria-invalid') === 'true');
  const config = {};
  h.window.__rules.collect(config);
  const saved = new Map(config.CustomTagRules.map(r => [r.Value, r.Label]));
  cases.forEach((c, i) => {
    assert.equal(flagged[i], !c.kept, `flagged: ${c.note}`);
    assert.equal(saved.get(`Tag ${i}`), c.kept ? c.stored : undefined, `saved: ${c.note}`);
  });
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
