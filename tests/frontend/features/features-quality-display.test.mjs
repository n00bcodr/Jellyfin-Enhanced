import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/** Real renderer, streams and summary, with only pipeline discovery stubbed. */
function setup(t, policy = 'representative', density = 'full') {
  const renderers = new Map();
  const h = createHarness({ html: '<div class="card"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div><div class="cardText">Show</div></div></div>',
    JE: { t: key => ({ series_quality_mixed: 'Mixed', series_quality_mixed_compact: '±', quality_edition_extended: 'Extended' }[key] || key),
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

const streams = () => [
  { Type: 'Video', Height: 1080, Codec: 'h264', VideoRangeType: 'SDR' },
  { Type: 'Video', Height: 2160, Codec: 'hevc', VideoRangeType: 'HDR10' },
  { Type: 'Video', Height: 2160, Codec: 'hevc', VideoRangeType: 'HDR10' },
  { Type: 'Audio', Language: 'eng', DisplayTitle: 'DTS 5.1', Channels: 6 },
  { Type: 'Audio', Language: 'eng', DisplayTitle: 'ATMOS 7.1', Channels: 8 },
  { Type: 'Audio', Language: 'eng', DisplayTitle: 'DTS 7.1', Channels: 8 },
  { Type: 'Audio', Language: 'deu', DisplayTitle: 'TRUEHD 5.1', Channels: 6 },
];
const movie = () => ({ Type: 'Movie', StreamData: { Streams: streams(), Sources: [] } });
const all = { qualityAudioDisplayMode: 'all', qualityVideoCodecDisplayMode: 'all', qualityHdrDisplayMode: 'all' };

test('All deduplicates and ranks per-track values; Highest default retains legacy detection', t => {
  const h = setup(t);
  const data = movie();
  assert.deepEqual(h.render(data), ['1080p', 'H264', 'DTS 7.1']);
  Object.assign(h.JE.currentSettings, all);
  assert.deepEqual(h.render(data), ['1080p', 'HDR10', 'SDR', 'HEVC', 'H264', 'ATMOS 7.1', 'TRUEHD 5.1', 'DTS 7.1', 'DTS 5.1']);
  h.JE.currentSettings.qualityAudioDisplayMode = 'highest';
  assert.deepEqual(h.render(data).filter(label => /DTS|ATMOS|TRUEHD/.test(label)), ['DTS 7.1']);
});

test('All uses cached distinct sets and exact-language tiers rather than recomputing raw tracks', t => {
  const h = setup(t);
  Object.assign(h.JE.currentSettings, all, { qualityTagsPreferredAudioLanguage: 'en-US' });
  const data = movie();
  data.StreamData.Streams.push({ Type: 'Audio', Language: 'en-US', DisplayTitle: 'ATMOS 7.1', Channels: 8 });
  data.StreamData.DistinctQualities = [
    { Category: 'audioInfo', Label: 'DTS 5.1', Language: 'eng' },
    { Category: 'audioInfo', Label: 'ATMOS 7.1', Language: 'en-US' },
    { Category: 'videoCodec', Label: 'AV1' },
    { Category: 'dynamicRange', Label: 'Dolby Vision' },
  ];
  assert.deepEqual(h.render(data), ['1080p', 'Dolby Vision', 'AV1', 'ATMOS 7.1']);
  h.JE.currentSettings.qualityTagsPreferredAudioLanguage = 'en-GB';
  assert.deepEqual(h.render(data).slice(-1), ['DTS 5.1']);
});


test('Sound All without a preference retains cached facts when raw audio tracks are absent', t => {
  const h = setup(t);
  Object.assign(h.JE.currentSettings, { qualityAudioDisplayMode: 'all' });
  const entry = { Type: 'Movie', StreamData: { Streams: [{ Type: 'Video', Height: 1080, Codec: 'h264' }],
    DistinctQualities: [{ Category: 'audioInfo', Label: 'ATMOS 7.1', Language: 'deu' }] } };
  assert.deepEqual(h.render(entry), ['1080p', 'H264', 'ATMOS 7.1']);
});

for (const [name, language, preferred, labelledLanguage, expected] of [
  ['preferred unlabelled English over German Atmos', 'eng', 'eng', 'deu', []],
  ['no preference includes German Atmos', 'eng', 'none', 'deu', ['ATMOS 7.1']],
  ['absent preferred language falls back', 'eng', 'fra', 'deu', ['ATMOS 7.1']],
  ['exact unlabelled region over labelled base', 'en-US', 'en-US', 'eng', []],
  ['unlabelled base for unavailable region', 'eng', 'en-AU', 'deu', []],
  ['absent exact region uses labelled base', 'deu', 'en-AU', 'eng', ['ATMOS 7.1']],
  ['only unlabelled tracks with preference', 'eng', 'eng', null, []],
  ['only unlabelled tracks without preference', 'eng', 'none', null, []],
]) {
  test(`Sound All selects raw language tier: ${name}; cached and batch agree`, t => {
    const h = setup(t);
    Object.assign(h.JE.currentSettings, { qualityAudioDisplayMode: 'all', qualityTagsPreferredAudioLanguage: preferred });
    const raw = [{ Type: 'Video', Height: 1080, Codec: 'h264' },
      { Type: 'Audio', Language: language, Codec: 'aac', Channels: 2 }];
    if (labelledLanguage) raw.push({ Type: 'Audio', Language: labelledLanguage, DisplayTitle: 'ATMOS 7.1', Channels: 8 });
    const entry = { Type: 'Movie', StreamData: { Streams: raw, Sources: [], DistinctQualities: [
      { Category: 'videoCodec', Label: 'H264' }, { Category: 'dynamicRange', Label: 'SDR' },
      ...(labelledLanguage ? [{ Category: 'audioInfo', Label: 'ATMOS 7.1', Language: labelledLanguage }] : []),
    ] } };
    const labels = ['1080p', 'H264', ...expected];
    assert.deepEqual(h.render(entry), labels, 'server-cached distinct facts');
    delete entry.StreamData.DistinctQualities;
    assert.deepEqual(h.render(entry), labels, 'uncached stream facts');
    h.JE.core.tagLayout.clearCard(h.card);
    delete h.document.querySelector('.card').dataset.jeQualityTagged;
    h.renderers.get('quality').render(h.card, { Id: 'batch-language', Type: 'Movie', MediaStreams: raw, MediaSources: [] });
    assert.deepEqual([...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.textContent), labels, 'batch fallback');
  });
}

for (const [threshold, present] of [['off', true], ['720p', true], ['1080p', true], ['4k', false], ['invalid', true]]) {
  test(`minimum ${threshold} filters inclusively before caps`, t => {
    const h = setup(t); Object.assign(h.JE.currentSettings, all, { qualityMinimumResolution: threshold, qualityHideSdr: true });
    const labels = h.render(movie());
    assert.equal(labels.includes('1080p'), present);
    assert.ok(!labels.includes('SDR'));
    assert.ok(labels.includes('HDR10'));
  });
}

test('per-category inheritance, compact labels and group caps count extra distinct values', t => {
  const h = setup(t, 'representative', 'compact');
  Object.assign(h.JE.pluginConfig, { QualityAudioDisplayMode: 'all', QualityMinimumResolution: '4k' });
  Object.assign(h.JE.currentSettings, { tagGroupCaps: { quality: 2 } });
  h.render(movie());
  assert.equal(h.document.querySelectorAll('.quality-overlay-label').length, 2);
  assert.deepEqual([...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.textContent), ['H264', 'ATMOS']);
  // Caps apply before the layout fitter; no overflow chip represents deliberately capped values.
  assert.equal(h.document.querySelector('.je-tag-more'), null);
});

for (const [policy, expected] of [['representative', ['H264']], ['latest', ['AV1']], ['best', ['AV1', 'HEVC', 'H264']], ['shared', ['HEVC']], ['mixed', ['AV1', 'HEVC', 'H264', 'Mixed']]]) {
  test(`All ${policy} respects the container set policy`, t => {
    const h = setup(t, policy); Object.assign(h.JE.currentSettings, { qualityVideoCodecDisplayMode: 'all', showResolutionTag: false, showAudioInfoTag: false, showDynamicRangeTag: false });
    const data = { Type: 'Season', StreamData: { Streams: [{ Type: 'Video', Codec: 'h264' }] }, QualitySummary: { EpisodeCount: 2,
      Categories: { videoCodec: { Best: 'AV1', Latest: 'AV1', AllAgree: false, AllSetsAgree: false, All: ['AV1', 'HEVC', 'H264'], Shared: ['HEVC'], LatestAll: ['AV1'] } } } };
    assert.deepEqual(h.render(data), expected);
  });
}

test('batch fallback and mode changes cannot reuse a computed Highest-only cache', t => {
  const h = setup(t); const renderer = h.renderers.get('quality');
  const item = { Id: 'batch', Type: 'Movie', MediaStreams: streams(), MediaSources: [] };
  renderer.render(h.card, item);
  assert.ok(!h.document.querySelector('[data-quality="ATMOS"]'));
  Object.assign(h.JE.currentSettings, all);
  h.JE.core.tagLayout.clearCard(h.card); delete h.document.querySelector('.card').dataset.jeQualityTagged;
  assert.equal(renderer.renderFromCache(h.card, 'batch'), false);
  renderer.render(h.card, item);
  assert.ok(h.document.querySelector('[data-quality="ATMOS"]'));
  assert.equal(h.document.querySelectorAll('[data-quality="HEVC"]').length, 1);
});


test('Bands overflow counts every eligible extra stream value after compact presentation', t => {
  const h = setup(t, 'representative', 'compact');
  Object.assign(h.JE.currentSettings, all, { tagLayout: 'bands' });
  h.render(movie());
  const proto = h.window.HTMLElement.prototype;
  proto.getBoundingClientRect = function () {
    const width = this.classList.contains('je-tag-more') ? 20 : this.parentElement?.dataset?.jeGroup ? 30 : 0;
    return { width, height: width ? 18 : 0, top: 0, left: 0, right: width, bottom: 18 };
  };
  Object.defineProperty(h.window.Element.prototype, 'clientWidth', { configurable: true, get() { return this.matches('.je-tag-host, .je-tag-slot') ? 113 : 0; } });
  Object.defineProperty(h.window.Element.prototype, 'clientHeight', { configurable: true, get() { return this.matches('.je-tag-host') ? 170 : 0; } });
  h.JE.core.tagLayout.flushFit();
  const hidden = h.document.querySelectorAll('.quality-overlay-label[data-je-overflow]');
  assert.ok(hidden.length > 0);
  assert.equal(h.document.querySelector('.je-tag-more').textContent, `+${hidden.length}`);
});

for (const [width, height, expected] of [[1920, 800, '1080p'], [2560, 1080, '1440p'], [3840, 1600, '4K'], [7680, 2160, '8K'], [1280, 544, '720p'], [0, 800, '720p']]) {
  test(`cropped dimensions ${width}x${height} agree in cached and batch quality paths`, t => {
    const h = setup(t), raw = [{ Type: 'Video', Width: width, Height: height }];
    assert.deepEqual(h.render({ Type: 'Movie', StreamData: { Streams: raw } }), [expected]);
    h.JE.core.tagLayout.clearCard(h.card); delete h.document.querySelector('.card').dataset.jeQualityTagged;
    h.renderers.get('quality').render(h.card, { Id: 'batch', Type: 'Movie', MediaStreams: raw });
    assert.deepEqual([...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.textContent), [expected]);
  });
}

const mergedMovie = () => ({ Type: 'Movie', StreamData: {
  Streams: [
    { Type: 'Video', SourceId: 'first', Width: 1920, Height: 800, Codec: 'h264', VideoRangeType: 'SDR' },
    { Type: 'Audio', SourceId: 'first', Language: 'eng', Codec: 'dts', DisplayTitle: 'DTS 5.1', Channels: 6 },
    { Type: 'Video', SourceId: 'second', Width: 3840, Height: 1600, Codec: 'hevc', VideoRangeType: 'HDR10' },
    { Type: 'Audio', SourceId: 'second', Language: 'eng', DisplayTitle: 'ATMOS 7.1', Channels: 8 },
  ],
  DistinctQualities: [
    { Category: 'videoCodec', Label: 'H264', SourceId: 'first' },
    { Category: 'dynamicRange', Label: 'SDR', SourceId: 'first' },
    { Category: 'audioInfo', Label: 'DTS 5.1', Language: 'eng', SourceId: 'first' },
    { Category: 'videoCodec', Label: 'HEVC', SourceId: 'second' },
    { Category: 'dynamicRange', Label: 'HDR10', SourceId: 'second' },
    { Category: 'audioInfo', Label: 'ATMOS 7.1', Language: 'eng', SourceId: 'second' },
  ],
  Sources: [{ Id: 'first', Source: 'WEB', Path: 'Film.mkv' }, { Id: 'second', Source: 'REMUX', Edition: 'Extended', Path: 'Film.IMAX.mkv' }],
} });

for (const cachedFacts of [true, false]) test(`merged selection filters every category together (${cachedFacts ? 'cached' : 'derived'} All facts)`, t => {
  const h = setup(t); Object.assign(h.JE.currentSettings, all, { showSourceTag: true, showEditionTag: true });
  const entry = mergedMovie(); if (!cachedFacts) delete entry.StreamData.DistinctQualities;
  assert.deepEqual(h.render(entry, 'movie'), ['1080p', 'WEB', 'SDR', 'H264', 'DTS 5.1']);
  h.window.localStorage.setItem('je-quality-source', JSON.stringify({ movie: 'second' }));
  assert.deepEqual(h.render(entry, 'movie'), ['4K', 'REMUX', 'HDR10', 'IMAX', 'HEVC', 'ATMOS 7.1', 'Extended']);
  h.window.localStorage.setItem('je-quality-source', JSON.stringify({ movie: 'removed-version' }));
  assert.deepEqual(h.render(entry, 'movie'), ['1080p', 'WEB', 'SDR', 'H264', 'DTS 5.1']);
});

test('batch hot and persistent caches miss on version changes and recompute using nested source streams', t => {
  const h = setup(t); Object.assign(h.JE.currentSettings, all);
  const entry = mergedMovie();
  const item = { Id: 'movie', Type: 'Movie', MediaStreams: entry.StreamData.Streams,
    MediaSources: entry.StreamData.Sources.map(s => ({ ...s, MediaStreams: entry.StreamData.Streams.filter(st => st.SourceId === s.Id) })) };
  const renderer = h.renderers.get('quality'), clear = () => { h.JE.core.tagLayout.clearCard(h.card); delete h.document.querySelector('.card').dataset.jeQualityTagged; };
  renderer.render(h.card, item);
  assert.ok(h.document.querySelector('[data-quality="H264"]'));
  clear(); h.window.localStorage.setItem('je-quality-source', '{"movie":"second"}');
  assert.equal(renderer.renderFromCache(h.card, 'movie'), false);
  renderer.render(h.card, item);
  assert.deepEqual([...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.textContent), ['4K', 'REMUX', 'HDR10', 'IMAX', 'HEVC', 'ATMOS 7.1', 'Extended']);
  clear(); renderer.renderFromCache(h.card, 'movie');
  assert.ok(h.document.querySelector('[data-quality="HEVC"]'));
  clear(); h.window.localStorage.setItem('je-quality-source', '{"movie":"first"}');
  assert.equal(renderer.renderFromCache(h.card, 'movie'), false);
  renderer.render(h.card, { ...item, MediaStreams: undefined });
  assert.ok(h.document.querySelector('[data-quality="H264"]'));
  assert.equal(h.document.querySelector('[data-quality="HEVC"]'), null);
});

test('version picker changes are normalized, remembered, and idempotently watched', t => {
  const h = setup(t); h.window.location.hash = '#/details?id=MO-VIE';
  h.document.body.insertAdjacentHTML('beforeend', '<select class="selectSource"><option value="first">First</option><option value="second">Second</option></select>');
  const select = h.document.querySelector('.selectSource');
  h.JE.initializeQualityTags(); select.value = 'second'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem('je-quality-source')), { movie: 'second' });
  assert.ok(h.render(mergedMovie(), 'movie').includes('HEVC'));
  select.value = 'first'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.ok(h.render(mergedMovie(), 'movie').includes('H264'));
});

for (const stored of ['null', '[]', '42', '"invalid"', '{broken']) test(`invalid version preference document ${stored} falls back safely`, t => {
  const h = setup(t); h.window.localStorage.setItem('je-quality-source', stored);
  assert.ok(h.render(mergedMovie(), 'movie').includes('H264'));
});

test('an unavailable preference write retains the chosen version in memory', t => {
  const h = setup(t); h.window.location.hash = '#/details?id=movie';
  h.window.Storage.prototype.setItem = () => { throw new Error('quota'); };
  h.document.body.insertAdjacentHTML('beforeend', '<select class="selectSource"><option value="second">Second</option></select>');
  h.document.querySelector('.selectSource').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.ok(h.render(mergedMovie(), 'movie').includes('HEVC'));
});

test('returning to details restores the remembered picker option and cancels an obsolete page restore', async t => {
  const h = setup(t); h.window.location.hash = '#/details?id=movie';
  h.window.localStorage.setItem('je-quality-source', '{"movie":"second"}');
  h.document.body.insertAdjacentHTML('beforeend', '<div id="itemDetailPage"><select class="selectSource"><option value="first">First</option><option value="second">Second</option></select></div>');
  h.document.dispatchEvent(new h.window.Event('viewshow'));
  await new Promise(resolve => h.window.setTimeout(resolve, 350));
  assert.equal(h.document.querySelector('.selectSource').value, 'second');
  h.document.querySelector('.selectSource').value = 'first';
  h.document.dispatchEvent(new h.window.Event('viewshow'));
  h.window.location.hash = '#/details?id=another';
  await new Promise(resolve => h.window.setTimeout(resolve, 350));
  assert.equal(h.document.querySelector('.selectSource').value, 'first');
});


const audioCases = JSON.parse(readFileSync(new URL('../../fixtures/audio-stream-labels.json', import.meta.url)));
for (const row of audioCases) for (const density of ['full', 'compact']) {
  test(`stream-to-chip ${row.name} ${density} in Highest and All`, t => {
    const h = setup(t, 'representative', density);
    for (const qualityAudioDisplayMode of ['highest', 'all']) {
      Object.assign(h.JE.currentSettings, { qualityAudioDisplayMode });
      const entry = { Type: 'Movie', StreamData: { Streams: [row.stream], Sources: [] } };
      assert.deepEqual(h.render(entry), [row[density]], qualityAudioDisplayMode);
      h.JE.core.tagLayout.clearCard(h.card);
      delete h.document.querySelector('.card').dataset.jeQualityTagged;
      h.renderers.get('quality').render(h.card, { Id: 'batch-audio', Type: 'Movie', MediaStreams: [row.stream] });
      assert.deepEqual([...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.textContent), [row[density]], 'batch path');
    }
  });
}

for (const row of audioCases) test(`legacy Full stream labels stay unchanged for ${row.name}`, t => {
  const h = setup(t);
  h.JE.currentSettings.tagLayoutSettingsVersion = 0;
  assert.deepEqual(h.render({ Type: 'Movie', StreamData: { Streams: [row.stream] } }), [row.legacyFull]);
});
