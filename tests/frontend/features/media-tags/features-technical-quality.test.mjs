import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../../helpers/harness.mjs';

const cases = JSON.parse(readFileSync(new URL('../../../fixtures/technical-quality.json', import.meta.url)));
const onlyTechnical = { showResolutionTag: false, showVideoCodecTag: false, showRuntimeTag: true, showAspectRatioTag: true, showFrameRateTag: true };
const en = JSON.parse(readFileSync(new URL('../../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url)));

/** Register the real quality factory; optionally exercise its real layout presentation. */
function setup(t, settings = {}, layout = false) {
  const renderers = new Map();
  const h = createHarness({ html: '<div class="card" data-id="a"><div class="cardBox"><div class="cardScalable"><div class="je-tag-host"></div></div><div class="cardText">Film</div></div></div>',
    JE: { currentSettings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', tagLabelDensity: 'full', ...settings },
      t: key => en[key] || key, pluginConfig: { TagCacheServerMode: false },
      session: { getUserId: () => 'a', getServerId: () => 's', onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (name, renderer) => renderers.set(name, renderer), clearProcessed() {}, scheduleScan() {} } } });
  t.after(() => h.close());
  h.load('core/ui-kit.js'); h.load('core/tag-renderer-base.js');
  if (layout) h.load('core/tag-layout.js');
  h.load('tags/qualitytags.js'); h.JE.initializeQualityTags();
  const host = h.document.querySelector('.je-tag-host');
  return { ...h, host, renderer: renderers.get('quality'),
    labels: () => Array.from(h.document.querySelectorAll('.quality-overlay-label')).map(el => el.textContent) };
}

for (const row of cases) test(`technical labels, both densities: ${row.name}`, async t => {
  const h = setup(t, { ...onlyTechnical, tagLayoutSettingsVersion: 1, tagGroupCaps: { quality: 0 } }, true);
  const entry = { Type: 'Movie', StreamData: { RunTimeTicks: row.ticks, Streams: [row.video] } };
  h.renderer.renderFromServerCache(h.host, entry, 'a');
  assert.deepEqual(h.labels(), row.labels);
  h.JE.currentSettings.tagLabelDensity = 'compact';
  await h.JE.reinitializeTagLayout();
  assert.deepEqual(h.labels(), row.compact);
  h.JE.currentSettings.tagLabelDensity = 'full';
  await h.JE.reinitializeTagLayout();
  assert.deepEqual(h.labels(), row.labels);
});

test('technical categories default off, reorder independently, and batch uses the same metadata', t => {
  const h = setup(t, { showResolutionTag: false, showVideoCodecTag: false });
  const row = cases[0];
  const item = { Id: 'a', Type: 'Movie', RunTimeTicks: row.ticks, MediaStreams: [row.video] };
  h.renderer.render(h.host, item, { stripRevision: 'none' });
  assert.deepEqual(h.labels(), []);
  Object.assign(h.JE.currentSettings, onlyTechnical, { frameRateTagOrder: 1, aspectRatioTagOrder: 2 });
  h.JE.reinitializeQualityTags();
  h.renderer.render(h.host, item, { stripRevision: 'none' });
  assert.deepEqual(h.labels(), ['24p', '2.39:1', '1h 52m']);
  h.JE.currentSettings.showAspectRatioTag = false;
  h.JE.reinitializeQualityTags();
  h.renderer.renderFromCache(h.host, 'a');
  assert.deepEqual(h.labels(), ['24p', '1h 52m']);
});

test('a runtime reads in the user\'s own hour and minute abbreviations, the label staying its identity', async t => {
  const h = setup(t, { ...onlyTechnical, showAspectRatioTag: false, showFrameRateTag: false, tagLayoutSettingsVersion: 1, tagGroupCaps: { quality: 0 } }, true);
  const forms = { quality_runtime_hours: '{hours} h {minutes} min', quality_runtime_hours_compact: '{hours}:{minutes}', quality_runtime_minutes: '{minutes} min' };
  h.JE.t = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replace(`{${name}}`, value), forms[key] || en[key] || key);
  h.renderer.renderFromServerCache(h.host, { Type: 'Movie', StreamData: { RunTimeTicks: 112 * 600000000, Streams: [cases[0].video] } }, 'a');
  assert.deepEqual(h.labels(), ['1 h 52 min']);
  h.JE.currentSettings.tagLabelDensity = 'compact';
  await h.JE.reinitializeTagLayout();
  assert.deepEqual(h.labels(), ['1:52']);
  const m = setup(t, { ...onlyTechnical, showAspectRatioTag: false, showFrameRateTag: false, tagLayoutSettingsVersion: 1, tagGroupCaps: { quality: 0 } }, true);
  m.JE.t = h.JE.t;
  m.renderer.renderFromServerCache(m.host, { Type: 'Movie', StreamData: { RunTimeTicks: 47 * 600000000, Streams: [cases[0].video] } }, 'a');
  assert.deepEqual(m.labels(), ['47 min']);
});

test('cropped width corrects resolution while subtitle titles remain excluded from special-format signals', t => {
  const h = setup(t);
  h.renderer.renderFromServerCache(h.host, { StreamData: { Streams: [
    { Type: 'Video', Width: 3840, Height: 1200 }, { Type: 'Subtitle', Language: 'en', Title: 'IMAX subtitles', DisplayTitle: 'IMAX subtitles' }
  ] } }, 'a');
  assert.deepEqual(h.labels(), ['4K']);
});


test('web aspect tolerance table matches the server source', () => {
  execFileSync('python3', [fileURLToPath(new URL('../../../../scripts/generate_technical_ratios.py', import.meta.url)), '--check']);
});

test('technical metadata coexists with All display modes in cached and batch paths', t => {
  const h = setup(t, { ...onlyTechnical, showResolutionTag: true, showVideoCodecTag: true,
    qualityVideoCodecDisplayMode: 'all', tagGroupCaps: { quality: 0 } });
  const streams = [
    { Type: 'Video', Codec: 'hevc', Width: 3840, Height: 1200, AspectRatio: '2.40', RealFrameRate: 23.976 },
    { Type: 'Video', Codec: 'h264', Height: 1080 }
  ];
  const ticks = 112 * 60 * 10000000;
  h.renderer.renderFromServerCache(h.host, { Type: 'Movie', StreamData: { Streams: streams, RunTimeTicks: ticks } }, 'a');
  assert.deepEqual(h.labels(), ['4K', 'HEVC', 'H264', '1h 52m', '2.39:1', '24p']);
  h.JE.reinitializeQualityTags();
  h.renderer.render(h.host, { Id: 'b', Type: 'Movie', MediaStreams: streams, RunTimeTicks: ticks }, { stripRevision: 'none' });
  assert.deepEqual(h.labels(), ['4K', 'HEVC', 'H264', '1h 52m', '2.39:1', '24p']);
});
