import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';

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
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (key, renderer) => renderers.set(key, { ...renderer, render: (el, item, extras = {}) => renderer.render(el, item, { stripRevision: 'none', ...extras }) }), clearProcessed() {}, scheduleScan() {} } } });
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
    videoCodec: fact('H264'), audioInfo: fact('ATMOS 7.1', 'DTS 5.1', false) }, LegacyAudio: fact('ATMOS 7.1', 'DTS 5.1', false), LegacyAudioByLanguage: { de: fact('DTS 5.1') }, AudioByLanguage: { de: fact('DTS 5.1') }, LatestExtras: ['IMAX'] } });

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

test('the source follows the policy across episodes while the edition stays representative, and latest switches both', t => {
  const h = setup(t, 'mixed');
  const data = { ...entry(), Source: 'WEB', Edition: 'Criterion' };
  // A season upgraded piecemeal: WEB first, REMUX latest.
  data.QualitySummary.Categories.source = { Best: 'REMUX', Latest: 'REMUX', Values: ['WEB', 'REMUX'], AllAgree: false, All: ['REMUX', 'WEB'], Shared: [], LatestAll: ['REMUX'], AllSetsAgree: false };
  data.QualitySummary.LatestExtras = ['edition:Extended'];
  h.render(data);
  const labels = () => [...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.dataset.quality);
  assert.ok(labels().includes('REMUX'), 'best source across episodes');
  assert.ok(!labels().includes('WEB'));
  assert.ok(labels().includes('Criterion'), 'the edition stays with the representative episode');
  assert.ok(labels().includes('Mixed'));
  h.JE.currentSettings.seriesQualityAggregation = 'shared';
  h.render(data);
  assert.ok(!labels().includes('REMUX') && !labels().includes('WEB'), 'no source every episode shares');
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

for (const [category, setting] of [['resolution', 'showResolutionTag'], ['dynamicRange', 'showDynamicRangeTag'],
  ['videoCodec', 'showVideoCodecTag'], ['audioInfo', 'showAudioInfoTag']]) {
  for (const path of ['server', 'batch']) test(`${path} cached Mixed follows ${setting} off and on with the same facts after reinitialization`, t => {
    const h = setup(t, 'mixed');
    const data = entry(); data.Id = 'retained';
    Object.entries(data.QualitySummary.Categories).forEach(([key, facts]) => { facts.AllAgree = key !== category; });
    const clear = () => {
      h.JE.core.tagLayout.clearCard(h.card);
      delete h.document.querySelector('.card').dataset.jeQualityTagged;
    };
    const labels = () => [...h.document.querySelectorAll('.quality-overlay-label')].map(chip => chip.textContent);
    const render = () => {
      clear();
      if (path === 'server') return h.render(data, data.Id);
      assert.equal(h.renderers.get('quality').renderFromCache(h.card, data.Id), true, 'retained batch facts avoid fetching');
      return labels();
    };
    if (path === 'batch') h.renderers.get('quality').render(h.card, data, { firstEpisode: { MediaStreams: [{ Type: 'Video', Height: 480 }] } });
    assert.ok(render().includes('Mixed'));
    h.JE.currentSettings[setting] = false;
    h.JE.reinitializeQualityTags();
    assert.ok(!render().includes('Mixed'), 'only differing category is disabled');
    h.JE.currentSettings[setting] = true;
    h.JE.reinitializeQualityTags();
    assert.ok(render().includes('Mixed'), 're-enabling the differing category restores Mixed');
  });
}

for (const type of ['Series', 'Season']) test(`${type} never shows the latest episode's version count under any policy`, t => {
  const h = setup(t, 'latest');
  h.JE.currentSettings.showVersionsTag = true;
  h.JE.reinitializeQualityTags();
  const data = { ...entry(), Type: type };
  data.QualitySummary.LatestExtras = ['IMAX', 'versions:2']; // stored before schema 31
  data.StreamData = { Streams: [{ Type: 'Video', SourceId: 'a', Height: 1080, Codec: 'h264' }, { Type: 'Video', SourceId: 'b', Height: 2160, Codec: 'hevc' }], Sources: [{ Id: 'a' }, { Id: 'b' }] };
  for (const policy of ['representative', 'latest', 'best', 'shared', 'mixed']) {
    h.JE.currentSettings.seriesQualityAggregation = policy;
    assert.ok(!h.render(data).some(label => /version|×/.test(label)), policy);
  }
});

const audioAggregation = JSON.parse(readFileSync(new URL('../../../fixtures/audio-aggregation.json', import.meta.url)));
for (const row of audioAggregation) for (const type of ['Series', 'Season']) {
  test(`${type} ${row.name} audio preserves every aggregation policy, language tier and display mode under the caller gate`, t => {
    const h = setup(t);
    for (const expected of row.expected) for (const density of expected.legacy ? [undefined, 'full', 'compact'] : ['full']) {
      Object.assign(h.JE.currentSettings, { tagLabelDensity: density, tagLayoutSettingsVersion: expected.legacy ? 0 : 1,
        seriesQualityAggregation: expected.policy, qualityAudioDisplayMode: expected.mode,
        qualityTagsPreferredAudioLanguage: expected.preferred });
      assert.deepEqual(h.render({ ...row.entry, Type: type }), expected.labels, JSON.stringify(expected));
      h.JE.core.tagLayout.clearCard(h.card);
      delete h.document.querySelector('.card').dataset.jeQualityTagged;
      const renderer = h.renderers.get('quality');
      renderer.render(h.card, { ...row.entry, Type: type, Id: 'batch-aggregate' },
        { firstEpisode: { MediaStreams: row.episodes[0].Streams.Streams } });
      assert.deepEqual([...h.document.querySelectorAll('.quality-overlay-label')].map(e => e.textContent), expected.labels, 'batch ' + JSON.stringify(expected));
      h.JE.core.tagLayout.clearCard(h.card);
      delete h.document.querySelector('.card').dataset.jeQualityTagged;
      assert.equal(renderer.renderFromCache(h.card, 'batch-aggregate'), true);
      assert.deepEqual([...h.document.querySelectorAll('.quality-overlay-label')].map(e => e.textContent), expected.labels, 'retained batch facts');
    }
  });
}
