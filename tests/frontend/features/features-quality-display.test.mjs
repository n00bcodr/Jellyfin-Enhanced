import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// The harness signs in user 'a' on server 's'.
const SRC_KEY = 'je-quality-source:s:a';

/** Real renderer, streams and summary, with only pipeline discovery stubbed. */
function setup(t, policy = 'representative', density = 'full', stored = null) {
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
  if (stored) {
    h.window.localStorage.setItem('JellyfinEnhanced-qualityTagsCache:identity-owner', 's:a');
    h.window.localStorage.setItem('JellyfinEnhanced-qualityTagsCache', JSON.stringify(stored));
    h.JE.pluginConfig.EnableTagsLocalStorageFallback = true;
  }
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

test('All deduplicates and ranks per-track values; Highest takes the best single track', t => {
  const h = setup(t);
  const data = movie();
  // Codec and channels come from the same (best-ranked) track, never DTS from one and 7.1 from another.
  assert.deepEqual(h.render(data), ['1080p', 'H264', 'ATMOS 7.1']);
  Object.assign(h.JE.currentSettings, all);
  assert.deepEqual(h.render(data), ['1080p', 'HDR10', 'SDR', 'HEVC', 'H264', 'ATMOS 7.1', 'TRUEHD 5.1', 'DTS 7.1', 'DTS 5.1']);
  h.JE.currentSettings.qualityAudioDisplayMode = 'highest';
  assert.deepEqual(h.render(data).filter(label => /DTS|ATMOS|TRUEHD/.test(label)), ['ATMOS 7.1']);
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
  assert.ok(h.document.querySelector('[data-quality="ATMOS"]'));
  assert.ok(!h.document.querySelector('[data-quality="DTS"]'));
  Object.assign(h.JE.currentSettings, all);
  h.JE.core.tagLayout.clearCard(h.card); delete h.document.querySelector('.card').dataset.jeQualityTagged;
  assert.equal(renderer.renderFromCache(h.card, 'batch'), false);
  renderer.render(h.card, item);
  assert.ok(h.document.querySelector('[data-quality="DTS"]'));
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

for (const [width, height, expected] of [[1920, 800, '1080p'], [2560, 1080, '1080p'], [2560, 1440, '1440p'], [720, 304, '480p'], [854, 356, '480p'], [3840, 1600, '4K'], [7680, 2160, '8K'], [1280, 544, '720p'], [0, 800, '720p']]) {
  test(`cropped dimensions ${width}x${height} agree in cached and batch quality paths`, t => {
    const h = setup(t), raw = [{ Type: 'Video', Width: width, Height: height }];
    assert.deepEqual(h.render({ Type: 'Movie', StreamData: { Streams: raw } }), [expected]);
    h.JE.core.tagLayout.clearCard(h.card); delete h.document.querySelector('.card').dataset.jeQualityTagged;
    h.renderers.get('quality').render(h.card, { Id: 'batch', Type: 'Movie', MediaStreams: raw });
    assert.deepEqual([...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.textContent), [expected]);
  });
}

const movieId = 'aabbccdd00112233445566778899aaff';
const dashedMovieId = 'AABBCCDD-0011-2233-4455-66778899AAFF';

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
  assert.deepEqual(h.render(entry, movieId), ['1080p', 'WEB', 'SDR', 'H264', 'DTS 5.1']);
  h.window.localStorage.setItem(SRC_KEY, JSON.stringify({ [movieId]: 'second' }));
  assert.deepEqual(h.render(entry, movieId), ['4K', 'REMUX', 'HDR10', 'IMAX', 'HEVC', 'ATMOS 7.1', 'Extended']);
  h.window.localStorage.setItem(SRC_KEY, JSON.stringify({ [movieId]: 'removed-version' }));
  assert.deepEqual(h.render(entry, movieId), ['1080p', 'WEB', 'SDR', 'H264', 'DTS 5.1']);
});

test('batch hot and persistent caches miss on version changes and recompute using nested source streams', t => {
  const h = setup(t); Object.assign(h.JE.currentSettings, all);
  const entry = mergedMovie();
  const item = { Id: movieId, Type: 'Movie', MediaStreams: entry.StreamData.Streams,
    MediaSources: entry.StreamData.Sources.map(s => ({ ...s, MediaStreams: entry.StreamData.Streams.filter(st => st.SourceId === s.Id) })) };
  const renderer = h.renderers.get('quality'), clear = () => { h.JE.core.tagLayout.clearCard(h.card); delete h.document.querySelector('.card').dataset.jeQualityTagged; };
  renderer.render(h.card, item);
  assert.ok(h.document.querySelector('[data-quality="H264"]'));
  clear(); h.window.localStorage.setItem(SRC_KEY, JSON.stringify({ [movieId]: 'second' }));
  assert.equal(renderer.renderFromCache(h.card, movieId), false);
  renderer.render(h.card, item);
  assert.deepEqual([...h.document.querySelectorAll('.quality-overlay-label')].map(el => el.textContent), ['4K', 'REMUX', 'HDR10', 'IMAX', 'HEVC', 'ATMOS 7.1', 'Extended']);
  clear(); renderer.renderFromCache(h.card, movieId);
  assert.ok(h.document.querySelector('[data-quality="HEVC"]'));
  clear(); h.window.localStorage.setItem(SRC_KEY, JSON.stringify({ [movieId]: 'first' }));
  assert.equal(renderer.renderFromCache(h.card, movieId), false);
  renderer.render(h.card, { ...item, MediaStreams: undefined });
  assert.ok(h.document.querySelector('[data-quality="H264"]'));
  assert.equal(h.document.querySelector('[data-quality="HEVC"]'), null);
});

test('version picker changes are normalized, remembered, and idempotently watched', t => {
  const h = setup(t); h.window.location.hash = `#/details?id=${dashedMovieId}`;
  h.document.body.insertAdjacentHTML('beforeend', '<select class="selectSource"><option value="first">First</option><option value="second">Second</option></select>');
  const select = h.document.querySelector('.selectSource');
  h.JE.initializeQualityTags(); select.value = 'second'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem(SRC_KEY)), { [movieId]: 'second' });
  assert.ok(h.render(mergedMovie(), movieId).includes('HEVC'));
  const reloaded = setup(t);
  reloaded.window.localStorage.setItem(SRC_KEY, h.window.localStorage.getItem(SRC_KEY));
  assert.ok(reloaded.render(mergedMovie(), dashedMovieId).includes('HEVC'), 'the JSON object survives a fresh module load');
  select.value = 'first'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.ok(h.render(mergedMovie(), movieId).includes('H264'));
});

test('an unprobed first version gives way to the first probed one, and a release group never claims IMAX', t => {
  const h = setup(t); Object.assign(h.JE.currentSettings, all, { showSourceTag: true });
  const entry = { Type: 'Movie', StreamData: {
    Streams: [{ Type: 'Video', SourceId: 'second', Width: 3840, Height: 2160, Codec: 'hevc', VideoRangeType: 'HDR10' }],
    Sources: [{ Id: 'first', Source: 'WEB', Path: 'Film.2020.WEB.H264-IMAX.mkv' }, { Id: 'second', Source: 'REMUX', Path: 'Film.2020.2160p.Remux.HEVC-IMAX.mkv' }],
  } };
  const labels = h.render(entry, movieId);
  assert.ok(labels.includes('4K') && labels.includes('HEVC') && labels.includes('REMUX'), 'the probed version describes the card');
  assert.ok(!labels.includes('WEB'), 'never a mix of versions');
  assert.ok(!labels.includes('IMAX'), 'a group called IMAX is a name');
  // A remembered pick still wins, even an unprobed one (then only its naming facts show).
  h.window.localStorage.setItem(SRC_KEY, JSON.stringify({ [movieId]: 'first' }));
  assert.deepEqual(h.render(entry, movieId), ['WEB']);
});

test('a remembered version belongs to its server and user and never reaches another account', t => {
  const h = setup(t); Object.assign(h.JE.currentSettings, all);
  // A pick stored under the earlier browser-wide key belongs to no one: it is retired, not inherited.
  h.window.localStorage.setItem('je-quality-source', JSON.stringify({ [movieId]: 'second' }));
  assert.ok(h.render(mergedMovie(), movieId).includes('H264'));
  assert.equal(h.window.localStorage.getItem('je-quality-source'), null);
  h.window.location.hash = `#/details?id=${movieId}`;
  h.document.body.insertAdjacentHTML('beforeend', '<select class="selectSource"><option value="first">First</option><option value="second">Second</option></select>');
  const select = h.document.querySelector('.selectSource');
  h.JE.initializeQualityTags(); select.value = 'second'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.ok(h.render(mergedMovie(), movieId).includes('HEVC'), 'Alice sees her pick');
  let user = 'b';
  h.JE.session.getUserId = () => user;
  assert.ok(h.render(mergedMovie(), movieId).includes('H264'), 'Bob, with no pick, sees the first version');
  assert.equal(h.window.localStorage.getItem('je-quality-source:s:b'), null);
  user = 'a';
  assert.ok(h.render(mergedMovie(), movieId).includes('HEVC'), 'Alice keeps her pick on her return');
  // Signed out: a pick lasts in memory only.
  user = '';
  select.value = 'second'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.deepEqual(Object.keys(h.window.localStorage).filter(key => key.startsWith('je-quality-source')).sort(), [SRC_KEY]);
});

test('stored source preferences ignore hostile keys and non-string values while keeping valid picks', t => {
  const h = setup(t);
  const stored = JSON.parse('{"__proto__":"second","constructor":"second","prototype":"second","":"second"}');
  Object.assign(stored, { [movieId]: 'second', a1: null, a2: 42, a3: true, a4: {}, a5: ['second'] });
  h.window.localStorage.setItem(SRC_KEY, JSON.stringify(stored));
  for (const id of ['cc', 'e', 'a1', 'a2', 'a3', 'a4', 'a5']) {
    assert.ok(h.render(mergedMovie(), id).includes('H264'), `no pick from a hostile key or non-string value for ${id}`);
  }
  assert.ok(h.render(mergedMovie(), movieId).includes('HEVC'), 'the existing object format still supplies valid picks');
  h.window.location.hash = `#/details?id=${movieId}`;
  h.document.body.insertAdjacentHTML('beforeend', '<select class="selectSource"><option value="first">First</option></select>');
  h.document.querySelector('.selectSource').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.deepEqual(JSON.parse(h.window.localStorage.getItem(SRC_KEY)), { [movieId]: 'first' });
});

test('item ids with no hexadecimal characters neither select nor remember a source', t => {
  const h = setup(t);
  const stored = '{"":"second"}';
  h.window.localStorage.setItem(SRC_KEY, stored);
  for (const id of ['', 'XYZ-!_']) assert.ok(h.render(mergedMovie(), id).includes('H264'));
  h.window.location.hash = '#/details?id=XYZ-!_';
  h.document.body.insertAdjacentHTML('beforeend', '<select class="selectSource"><option value="second">Second</option></select>');
  h.document.querySelector('.selectSource').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.equal(h.window.localStorage.getItem(SRC_KEY), stored, 'no preference write for an empty normalized id');
});

test('source preferences trim the oldest pick and keep a refreshed pick among the newest 500', t => {
  const h = setup(t);
  const ids = Array.from({ length: 501 }, (_, n) => `a${n.toString(16).padStart(31, '0')}`);
  h.window.localStorage.setItem(SRC_KEY, JSON.stringify(Object.fromEntries(ids.slice(0, 500).map(id => [id, 'first']))));
  h.document.body.insertAdjacentHTML('beforeend', '<select class="selectSource"><option value="second">Second</option></select>');
  const select = h.document.querySelector('.selectSource');
  for (const id of [ids[0], ids[500]]) {
    h.window.location.hash = `#/details?id=${id}`;
    select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  }
  const stored = JSON.parse(h.window.localStorage.getItem(SRC_KEY));
  assert.deepEqual(Object.keys(stored), [...ids.slice(2, 500), ids[0], ids[500]]);
  assert.equal(stored[ids[0]], 'second');
  assert.equal(stored[ids[500]], 'second');
  assert.ok(h.render(mergedMovie(), ids[1]).includes('H264'), 'the oldest unrefreshed pick is gone');
  assert.ok(h.render(mergedMovie(), ids[0]).includes('HEVC'), 'the refreshed pick is retained');
});

for (const stored of ['null', '[]', '42', '"invalid"', '{broken']) test(`invalid version preference document ${stored} falls back safely`, t => {
  const h = setup(t); h.window.localStorage.setItem(SRC_KEY, stored);
  assert.ok(h.render(mergedMovie(), movieId).includes('H264'));
});

test('an unavailable preference write retains the chosen version in memory', t => {
  const h = setup(t); h.window.location.hash = `#/details?id=${movieId}`;
  h.window.Storage.prototype.setItem = () => { throw new Error('quota'); };
  h.document.body.insertAdjacentHTML('beforeend', '<select class="selectSource"><option value="second">Second</option></select>');
  h.document.querySelector('.selectSource').dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.ok(h.render(mergedMovie(), movieId).includes('HEVC'));
});

test('returning to details restores the remembered picker option and cancels an obsolete page restore', async t => {
  const h = setup(t); h.window.location.hash = `#/details?id=${movieId}`;
  h.window.localStorage.setItem(SRC_KEY, JSON.stringify({ [movieId]: 'second' }));
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

const legacyDocuments = JSON.parse(readFileSync(new URL('../../fixtures/audio-legacy-documents.json', import.meta.url)));
for (const row of legacyDocuments) test(`audio gate follows resolved layout version: ${row.name}`, t => {
  const h = setup(t);
  h.JE.currentSettings = Object.fromEntries(Object.entries(row.settings).map(([k, v]) => [k[0].toLowerCase() + k.slice(1), v]));
  h.JE.currentSettings.qualityTagsPreferredAudioLanguage = 'none';
  const layout = h.JE.core.tagLayout.normalizeSettings();
  assert.equal(layout.density, row.density);
  assert.deepEqual(h.render({ Type: 'Movie', StreamData: { Streams: [{ Type: 'Audio', Codec: 'ac3', Channels: 6 }] } }), [row.label]);
});

for (const density of [undefined, 'full', 'compact']) test(`version transition invalidates hot and server computed audio (${density ?? 'missing'})`, t => {
  const h = setup(t), renderer = h.renderers.get('quality');
  Object.assign(h.JE.currentSettings, { tagLayoutSettingsVersion: 0, tagLabelDensity: density });
  const track = { Type: 'Audio', Codec: 'ac3', Channels: 6 }, item = { Id: 'transition', Type: 'Movie', MediaStreams: [track] };
  const entry = { Type: 'Movie', StreamData: { Streams: [track] } };
  renderer.render(h.card, item);
  h.render(entry);
  const clear = () => { h.JE.core.tagLayout.clearCard(h.card); delete h.document.querySelector('.card').dataset.jeQualityTagged; };
  Object.assign(h.JE.currentSettings, { tagLayoutSettingsVersion: 1, tagLabelDensity: 'full' });
  clear();
  assert.equal(renderer.renderFromCache(h.card, item.Id), false, 'legacy hot labels cannot become normalized labels');
  assert.deepEqual(h.render(entry), ['Dolby Digital 5.1'], 'same server entry is re-detected');
  clear(); renderer.render(h.card, item);
  Object.assign(h.JE.currentSettings, { tagLayoutSettingsVersion: 0, tagLabelDensity: density });
  clear(); assert.equal(renderer.renderFromCache(h.card, item.Id), false, 'reverse transition also misses');
  assert.deepEqual(h.render(entry), ['5.1']);
});

for (const namingVersion of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]) test(`persisted naming-version ${namingVersion} matches only the current identity`, t => {
  const payload = { namingVersion, legacyAudio: false, displayModeKey: '000', audioLang: '', srcId: '',
    qualities: ['Dolby Digital 5.1'], type: 'Movie', aggregationPolicy: 'representative', timestamp: Date.now() };
  const h = setup(t, 'representative', 'full', { old: { v: 1, stripRevision: 'none', payload, timestamp: Date.now() } });
  assert.equal(h.renderers.get('quality').renderFromCache(h.card, 'old'), namingVersion === 23);
  assert.equal(h.document.querySelectorAll('.quality-overlay-label').length, namingVersion === 23 ? 1 : 0);
});

test('persisted current naming labels are still invalidated by a legacy-version transition', t => {
  const payload = { namingVersion: 23, legacyAudio: true, displayModeKey: '000', audioLang: '', srcId: '',
    qualities: ['5.1'], type: 'Movie', aggregationPolicy: 'representative', timestamp: Date.now() };
  const h = setup(t, 'representative', 'compact', { saved: { v: 1, stripRevision: 'none', payload, timestamp: Date.now() } });
  h.JE.currentSettings.tagLayoutSettingsVersion = 0;
  const renderer = h.renderers.get('quality');
  assert.equal(renderer.renderFromCache(h.card, 'saved'), true);
  h.JE.core.tagLayout.clearCard(h.card); delete h.document.querySelector('.card').dataset.jeQualityTagged;
  Object.assign(h.JE.currentSettings, { tagLayoutSettingsVersion: 1, tagLabelDensity: 'full' });
  assert.equal(renderer.renderFromCache(h.card, 'saved'), false);
});

const audioAliases = JSON.parse(readFileSync(new URL('../../fixtures/audio-alias-labels.json', import.meta.url)));
for (const row of audioAliases) for (const density of ['full', 'compact']) {
  test(`TRaSH stream alias ${row.alias} (${row.format}) → ${density}`, t => {
    const h = setup(t, 'representative', density);
    const variants = row.stream ? [row.stream] : [
      { DisplayTitle: row.alias }, { Codec: row.alias }, { Profile: row.alias },
      { Codec: row.codec, DisplayTitle: row.alias }, { Codec: row.codec, Profile: row.alias },
    ];
    for (const fields of variants) for (const mode of ['highest', 'all']) {
      h.JE.currentSettings.qualityAudioDisplayMode = mode;
      const track = { Type: 'Audio', Channels: 6, ...fields };
      const entry = { Type: 'Movie', StreamData: { Streams: [track] } };
      assert.deepEqual(h.render(entry), [row[density]], JSON.stringify({ fields, mode }));
      h.JE.core.tagLayout.clearCard(h.card); delete h.document.querySelector('.card').dataset.jeQualityTagged;
      h.renderers.get('quality').render(h.card, { Id: 'batch-alias', Type: 'Movie', MediaStreams: [track] });
      assert.deepEqual([...h.document.querySelectorAll('.quality-overlay-label')].map(e => e.textContent), [row[density]], 'batch ' + JSON.stringify({ fields, mode }));
    }
  });
}

test('the Versions chip counts an item\'s versions; series and seasons never show one', t => {
  const h = setup(t);
  Object.assign(h.JE.currentSettings, { showVersionsTag: true });
  const sources = [{ Id: 'first' }, { Id: 'second' }];
  const movieEntry = { Type: 'Movie', StreamData: { Streams: [{ Type: 'Video', Height: 1080, Codec: 'h264', SourceId: 'first' }, { Type: 'Video', Height: 2160, Codec: 'hevc', SourceId: 'second' }], Sources: sources } };
  assert.ok(h.render(movieEntry, 'movie').includes('2 versions'));
  const chip = h.document.querySelector('[data-je-quality-category="versions"]');
  assert.equal(chip.dataset.jeCompact, '×2');
  assert.ok(!h.render({ Type: 'Movie', StreamData: { Streams: [{ Type: 'Video', Height: 1080, Codec: 'h264', SourceId: 'first' }], Sources: [sources[0]] } }, 'single').some(label => /versions/.test(label)));
  assert.ok(!h.render({ ...movieEntry, Type: 'Series' }, 'series').some(label => /versions/.test(label)));
  h.JE.currentSettings.showVersionsTag = false;
  assert.ok(!h.render(movieEntry, 'off').some(label => /versions/.test(label)));
});

test("Jellyfin's own 3D format marks a version 3D without release words in its name", t => {
  const h = setup(t);
  const streams = [{ Type: 'Video', Height: 1080, Width: 1920, Codec: 'h264' }];
  assert.ok(h.render({ Type: 'Movie', StreamData: { Streams: streams, Sources: [{ Id: 'a', Path: 'Movie.mkv', Is3D: true }] } }, 'm1').includes('3D'));
  assert.ok(!h.render({ Type: 'Movie', StreamData: { Streams: streams, Sources: [{ Id: 'a', Path: 'Movie.mkv' }] } }, 'm2').includes('3D'));
  assert.ok(h.render({ Type: 'Movie', StreamData: { Streams: streams, Sources: [{ Id: 'a', Path: 'Movie.3D.HSBS.mkv' }] } }, 'm3').includes('3D'));
});
