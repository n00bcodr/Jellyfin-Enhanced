import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/** Real renderer, streams and summary, with only pipeline discovery stubbed. */
function setup(t, policy = 'representative', density = 'full') {
  const renderers = new Map();
  const h = createHarness({ html: '<div class="card"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div><div class="cardText">Show</div></div></div>',
    JE: { t: key => ({ series_quality_mixed: 'Mixed', series_quality_mixed_compact: '±' }[key] || key),
      currentSettings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', seriesQualityAggregation: policy,
        tagLabelDensity: density, tagLayoutSettingsVersion: 1, tagLayout: 'corners' },
      pluginConfig: { TagCacheServerMode: true },
      session: { getUserId: () => 'a', getServerId: () => 's', onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { registerRenderer: (key, renderer) => renderers.set(key, renderer), clearProcessed() {}, scheduleScan() {} } } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/qualitytags.js']) h.load(file);
  h.JE.initializeQualityTags();
  const card = h.document.querySelector('.cardImageContainer');
  const render = (entry, id = 'series') => {
    h.JE.core.tagLayout.clearCard(card);
    delete h.document.querySelector('.card').dataset.jeQualityTagged;
    renderers.get('quality').renderFromServerCache(card, entry, id);
    return [...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.textContent);
  };
  return { ...h, renderers, card, render };
}
const fact = (best, latest = best, agree = true) => ({ Best: best, Latest: latest, AllAgree: agree, Values: [best] });
const entry = () => ({ Type: 'Series', StreamData: { Streams: [{ Type: 'Video', Height: 1080, Codec: 'h264' }], Sources: [] },
  QualitySummary: { EpisodeCount: 2, Categories: { resolution: fact('4K', '720p', false), dynamicRange: fact('Dolby Vision', null, false),
    videoCodec: fact('H264'), audioInfo: fact('ATMOS 7.1', 'DTS 5.1', false) }, AudioByLanguage: { de: fact('DTS 5.1') }, LatestExtras: ['IMAX'] } });

for (const type of ['Series', 'Season']) for (const [policy, expected] of [
  ['representative', ['1080p', 'H264']], ['latest', ['720p', 'IMAX', 'H264', 'DTS 5.1']],
  ['best', ['4K', 'Dolby Vision', 'H264', 'ATMOS 7.1']], ['shared', ['H264']], ['mixed', ['4K', 'Dolby Vision', 'H264', 'ATMOS 7.1', 'Mixed']],
]) test(`${type} ${policy} applies the summary before category arrangement`, t => {
  const h = setup(t, policy); const data = { ...entry(), Type: type };
  assert.deepEqual(h.render(data), expected);
});

test('policy changes invalidate the computed server cache without refetching; legacy entries and collections retain streams', t => {
  const h = setup(t); const data = entry();
  assert.deepEqual(h.render(data), ['1080p', 'H264']);
  h.JE.currentSettings.seriesQualityAggregation = 'best';
  assert.ok(h.render(data).includes('4K'));
  const legacy = { ...data, QualitySummary: null };
  assert.deepEqual(h.render(legacy), ['1080p', 'H264']);
  assert.deepEqual(h.render({ ...entry(), Type: 'BoxSet' }), ['1080p', 'H264']);
});

test('aggregation keeps representative naming chips and switches them together for latest', t => {
  const h = setup(t, 'mixed');
  const data = { ...entry(), Source: 'WEB', Edition: 'Criterion' };
  data.QualitySummary.LatestExtras = ['REMUX', 'edition:Extended'];
  h.render(data);
  const labels = () => [...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.dataset.quality);
  assert.ok(labels().includes('WEB'));
  assert.ok(labels().includes('Criterion'));
  h.JE.currentSettings.seriesQualityAggregation = 'latest';
  h.render(data);
  assert.ok(labels().includes('REMUX'));
  assert.ok(labels().includes('Extended'));
  assert.ok(!labels().includes('WEB'));
});

test('mixed marker is styled and compacted to ±, and disabled differing categories do not produce a marker', t => {
  const h = setup(t, 'mixed', 'compact');
  const labels = h.render(entry());
  assert.ok(labels.includes('±'));
  assert.equal(h.document.querySelector('.quality-overlay-label.mixed').dataset.quality, 'Mixed');
  assert.equal(h.document.querySelector('.mixed').title, 'Mixed');
  Object.assign(h.JE.currentSettings, { showResolutionTag: false, showDynamicRangeTag: false, showAudioInfoTag: false });
  assert.deepEqual(h.render(entry()), ['H264']);
});

test('audio summary follows preferred language, and agreeing values survive shared without a marker', t => {
  const h = setup(t, 'shared'); h.JE.currentSettings.qualityTagsPreferredAudioLanguage = 'ger';
  assert.deepEqual(h.render(entry()), ['H264', 'DTS 5.1']);
  const data = entry(); Object.values(data.QualitySummary.Categories).forEach(f => { f.AllAgree = true; });
  h.JE.currentSettings.seriesQualityAggregation = 'mixed';
  assert.ok(!h.render(data).includes('Mixed'));
});

test('batch rendering reads QualitySummary instead of the representative episode', t => {
  const h = setup(t, 'best');
  h.renderers.get('quality').render(h.card, { ...entry(), Id: 'batch' }, { firstEpisode: { MediaStreams: [{ Type: 'Video', Height: 480 }] } });
  assert.ok([...h.document.querySelectorAll('.quality-overlay-label')].some(el => el.textContent === '4K'));
});


test('batch cache retains summary facts so changing policy never refetches episodes, including an empty shared result', t => {
  const h = setup(t, 'shared');
  const renderer = h.renderers.get('quality');
  const data = entry(); data.Id = 'batch-retained';
  Object.values(data.QualitySummary.Categories).forEach(facts => { facts.AllAgree = false; });
  renderer.render(h.card, data, { firstEpisode: { MediaStreams: [{ Type: 'Video', Height: 480 }] } });
  assert.equal(h.document.querySelectorAll('.quality-overlay-label').length, 0);
  h.JE.currentSettings.seriesQualityAggregation = 'mixed';
  assert.equal(renderer.renderFromCache(h.card, data.Id), true, 'summary cache hit suppresses a batch fetch');
  assert.ok([...h.document.querySelectorAll('.quality-overlay-label')].some(chip => chip.textContent === '4K'));
  assert.ok(h.document.querySelector('.mixed'));
});
