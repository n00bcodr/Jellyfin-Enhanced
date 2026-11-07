import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../helpers/harness.mjs';

const names = JSON.parse(readFileSync(new URL('../../fixtures/source-edition-names.json', import.meta.url)));
const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url)));

/** Register the real quality factory; optionally exercise its real layout presentation. */
function setup(t, settings = {}, layout = false) {
  const renderers = new Map();
  const h = createHarness({ html: '<div class="card" data-id="a"><div class="cardBox"><div class="cardScalable"><div class="je-tag-host"></div></div><div class="cardText">Film</div></div></div>',
    JE: { currentSettings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', tagLabelDensity: 'full', ...settings },
      t: key => en[key] || key, pluginConfig: { TagCacheServerMode: false },
      session: { getUserId: () => 'a', getServerId: () => 's', onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { registerRenderer: (name, renderer) => renderers.set(name, renderer), clearProcessed() {}, scheduleScan() {} } } });
  t.after(() => h.close());
  h.load('core/ui-kit.js'); h.load('core/tag-renderer-base.js');
  if (layout) h.load('core/tag-layout.js');
  h.load('tags/qualitytags.js'); h.JE.initializeQualityTags();
  const host = h.document.querySelector('.je-tag-host');
  return { ...h, host, renderer: renderers.get('quality'),
    labels: () => Array.from(h.document.querySelectorAll('.quality-overlay-label')).map(el => el.textContent) };
}

for (const row of names) test(`server naming projection: ${row.path}`, t => {
  const h = setup(t, { showLowQualitySourceTag: true });
  const entry = { Source: row.source, Edition: row.edition, StreamData: { Streams: [], Sources: [] } };
  h.renderer.renderFromServerCache(h.host, entry, 'a');
  assert.deepEqual(h.labels(), [row.source, row.edition].filter(Boolean));
});

test('batch and bulk-cache naming fields produce identical chips without file paths', t => {
  const h = setup(t);
  h.renderer.render(h.host, { Id: 'a', Type: 'Movie', Source: 'WEB', Edition: "Director's Cut", MediaStreams: [] }, {});
  assert.deepEqual(h.labels(), ['WEB', "Director's Cut"]);
  assert.ok(h.host.querySelector('[data-je-edition]').classList.contains('other-quality'));
});

test('category toggles, order and low-source gate apply to final eligible tags', t => {
  const h = setup(t, { editionTagOrder: 0 });
  h.renderer.renderFromServerCache(h.host, { Source: 'TS', Edition: 'Extended', StreamData: { Streams: [] } }, 'a');
  assert.deepEqual(h.labels(), ['Extended']);
  h.JE.currentSettings.showLowQualitySourceTag = true;
  h.JE.reinitializeQualityTags();
  h.renderer.renderFromServerCache(h.host, { Source: 'TS', Edition: 'Extended', StreamData: { Streams: [] } }, 'a');
  assert.deepEqual(h.labels(), ['Extended', 'TS']);
  Object.assign(h.JE.currentSettings, { showSourceTag: false, showEditionTag: false });
  h.JE.reinitializeQualityTags();
  h.renderer.renderFromServerCache(h.host, { Source: 'TS', Edition: 'Extended' }, 'a');
  assert.deepEqual(h.labels(), []);
});

test('IMAX keeps the special-format category when eligible, otherwise the edition category', t => {
  const h = setup(t);
  const entry = { Edition: 'IMAX', StreamData: { Streams: [], ItemName: 'Film IMAX' } };
  h.renderer.renderFromServerCache(h.host, entry, 'a');
  assert.deepEqual(h.labels(), ['IMAX']);
  assert.equal(h.host.querySelector('[data-je-edition]'), null);
  h.JE.currentSettings.showSpecialFormatTag = false;
  h.JE.reinitializeQualityTags();
  h.renderer.renderFromServerCache(h.host, entry, 'a');
  assert.deepEqual(h.labels(), ['IMAX']);
  const chip = h.host.querySelector('[data-je-edition]');
  assert.ok(chip);
  assert.match(h.window.getComputedStyle(chip).backgroundColor, /106, 27, 154/, 'edition IMAX uses the purple edition tint');
});

test('full and compact edition labels survive real layout presentation and density changes', async t => {
  const h = setup(t, { tagLayoutSettingsVersion: 1 }, true);
  h.renderer.renderFromServerCache(h.host, { Source: 'BluRay', Edition: "Director's Cut", StreamData: { Streams: [] } }, 'a');
  assert.deepEqual(h.labels(), ['BluRay', "Director's Cut"]);
  h.JE.currentSettings.tagLabelDensity = 'compact';
  await h.JE.reinitializeTagLayout();
  assert.deepEqual(h.labels(), ['BD', 'DC']);
  h.JE.currentSettings.tagLabelDensity = 'full';
  await h.JE.reinitializeTagLayout();
  assert.deepEqual(h.labels(), ['BluRay', "Director's Cut"]);
});

test('an unprobed file can show naming tags; custom edition text remains inert', t => {
  const h = setup(t);
  const custom = '<img src=x onerror=alert(1)>';
  h.renderer.renderFromServerCache(h.host, { Source: 'REMUX', Edition: custom }, 'a');
  assert.deepEqual(h.labels(), ['REMUX', custom]);
  assert.equal(h.host.querySelector('img'), null);
});

test('a series uses the representative episode naming fields in batch mode', t => {
  const h = setup(t);
  h.renderer.render(h.host, { Id: 'series', Type: 'Series' }, {
    firstEpisode: { Source: 'HDTV', Edition: 'Remastered', MediaStreams: [] }
  });
  assert.deepEqual(h.labels(), ['HDTV', 'Remastered']);
});


test('a title containing .disc inside a word is not a physical stub', t => {
  const h = setup(t);
  h.renderer.render(h.host, { Id: 'discourse', Type: 'Movie', Path: 'Movie.Discourse.mkv', MediaSources: [], MediaStreams: [] }, {});
  assert.deepEqual(h.labels(), []);
});

for (const [edition, short] of [["Director's Cut", 'DC'], ['Extended', 'Ext'], ['Unrated', 'Unr'], ['Remastered', 'Rem'], ['Criterion', 'CC'], ['Special Edition', 'Special']]) {
  test(`compact edition: ${edition}`, t => {
    const h = setup(t, { tagLayoutSettingsVersion: 1, tagLabelDensity: 'compact' }, true);
    h.renderer.renderFromServerCache(h.host, { Source: 'WEB', Edition: edition }, 'a');
    assert.deepEqual(h.labels(), ['WEB', short]);
  });
}


test('source and edition colour assets reproduce the generator, including apostrophes', () => {
  const generator = fileURLToPath(new URL('../../../scripts/build_poster_assets.py', import.meta.url));
  const generated = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('poster_assets',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.quality_colours()))
`, generator], { encoding: 'utf8' }));
  const shipped = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/Assets/PosterTags/quality-colours.json', import.meta.url)));
  assert.deepEqual(generated, shipped);
  assert.ok(generated.labels["Director's Cut"]);
  assert.equal(generated.labels['s Cut'], undefined);
});

test('the tag cache service documentation names the current schema constant', () => {
  const docs = readFileSync(new URL('../../../docs/advanced/project-structure.md', import.meta.url), 'utf8');
  const row = docs.split('\n').find(line => line.startsWith('| `TagCacheService.cs`, `TagCacheMonitor.cs` |'));
  assert.ok(row, 'the service has a documented row');
  assert.match(row, /current cache schema \(`CurrentCacheSchemaVersion`\)/);
});
