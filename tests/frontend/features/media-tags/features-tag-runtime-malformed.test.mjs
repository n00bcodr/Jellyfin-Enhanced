import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';

// What a card shows for a malformed list is a contract, not an accident: each read below stops on a bad member, the
// pipeline isolates that renderer, and native posters mirror where (QualityTagRules.Detect, LanguageFlagRules.Resolve).
// tests/poster/parity runs the same payloads through the C# resolver.

const video = { Type: 'Video', Codec: 'h264', Height: 1080, VideoRangeType: 'SDR', DisplayTitle: '1080p H264 SDR' };
const ID = 'a0000000000000000000000000000000';

function page(t, settings = {}, plugin = {}) {
  const renderers = new Map();
  const h = createHarness({
    html: `<div class="card" data-id="${ID}" data-type="Movie"><div class="cardScalable"><div class="cardImageContainer"></div></div></div>`,
    JE: {
      currentSettings: { genreTagsEnabled: true, languageTagsEnabled: true, qualityTagsEnabled: true, tagLayoutSettingsVersion: 1, ...settings },
      pluginConfig: { TagCacheServerMode: true, ...plugin },
      t: key => key,
      cdn: { flagSvg: code => `/flags/${code}.svg`, flagPng: code => `/flags/${code}.png` },
      _cacheManager: { register() {}, markDirty() {} },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (name, renderer) => renderers.set(name, renderer), getRenderer: name => renderers.get(name), clearProcessed() {}, scheduleScan() {} },
      core: { ui: { injectCss() {}, removeCss() {} } },
    },
    apiClient: { getUrl: path => path, ajax: async () => ({}), getUser: async () => ({}) },
  });
  t.after(() => h.close());
  for (const file of ['core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/rating-sources.js', 'tags/tag-layout-styles.js', 'tags/genretags.js', 'tags/languagetags.js', 'tags/qualitytags.js']) h.load(file);
  for (const name of ['Genre', 'Language', 'Quality']) h.JE[`initialize${name}Tags`]();
  /** One renderer's outcome on a fresh card; a failure stays inside it, as the pipeline keeps it. */
  const draw = (name, entry, how = 'renderFromServerCache') => {
    const card = h.document.querySelector('.card');
    card.outerHTML = `<div class="card" data-id="${ID}" data-type="${entry.Type || 'Movie'}"><div class="cardScalable"><div class="cardImageContainer"></div></div></div>`;
    const host = h.document.querySelector('.cardScalable');
    const renderer = renderers.get(name);
    try {
      if (how === 'render') renderer.render(host, { Id: ID, ...entry }, { stripRevision: 'none' });
      else renderer.renderFromServerCache(host, entry, ID);
    } catch { /* The pipeline logs it and moves to the next renderer. */ }
    return host;
  };
  const quality = (entry, how) => [...draw('quality', { Type: 'Movie', ...entry }, how).querySelectorAll('.quality-overlay-label')].map(chip => chip.dataset.quality);
  const genres = (entry, how) => [...draw('genre', { Type: 'Movie', ...entry }, how).querySelectorAll('.genre-tag')].map(chip => chip.title);
  const languages = (entry, how) => [...draw('language', { Type: 'Movie', ...entry }, how).querySelectorAll('.language-chip, .language-flag, img')].map(chip => chip.dataset.lang || chip.dataset.jeLanguageLabel);
  return { ...h, quality, genres, languages };
}

const streamData = (Streams, Sources) => ({ StreamData: { Streams, Sources, ItemName: 'Movie', ItemPath: 'movie.mkv' } });

for (const [name, streams, sources, expected] of [
  ['a null stream ends detection', [video, null], [{ Path: 'movie.mkv' }], []],
  ['a null source the 3D scan reaches ends detection', [video], [{ Path: 'movie.mkv', Name: 'Movie' }, null], []],
  ['a null first source ends detection', [video], [null, { Path: 'movie.3d.hsbs.mkv' }], []],
  ['a null source after a 3D match is never read', [video], [{ Path: 'movie.3d.hsbs.mkv' }, null], ['1080p', 'H264', '3D']],
  ['a null source after a later 3D match is never read', [video], [{ Name: 'Movie' }, { Path: 'x.3d.mvc.mkv' }, null], ['1080p', 'H264', '3D']],
  ['a null stream of another version is narrowed away first', [{ ...video, SourceId: 'one' }, null], [{ Id: 'one', Path: 'movie.mkv' }], ['1080p', 'H264']],
  ['a null version stays visible to the null-safe reads', [video], [null], null],
]) test(`quality: ${name}`, t => {
  const h = page(t);
  const drawn = h.quality(streamData(streams, sources));
  if (expected === null) assert.deepEqual(drawn, [], 'the 3D scan still reaches it');
  else assert.deepEqual([...drawn].sort(), [...expected].sort());
});

test('quality: a null distinct fact ends detection only when an All mode reads it', t => {
  const entry = { DistinctQualities: [{ Category: 'videoCodec', Label: 'H264' }, null] };
  const data = streamData([video], [{ Path: 'movie.mkv' }]);
  const off = page(t);
  assert.ok(off.quality({ ...data, StreamData: { ...data.StreamData, ...entry } }).includes('H264'));
  const all = page(t, { qualityVideoCodecDisplayMode: 'all' });
  assert.deepEqual(all.quality({ ...data, StreamData: { ...data.StreamData, ...entry } }), []);
});

test('quality: a missing label in an All mode draws nothing rather than a blank chip', t => {
  const h = page(t, { qualityVideoCodecDisplayMode: 'all', qualityHdrDisplayMode: 'all' });
  const data = streamData([video], [{ Path: 'movie.mkv' }]);
  const facts = [{ Category: 'videoCodec', Label: null }];
  assert.deepEqual(h.quality({ ...data, StreamData: { ...data.StreamData, DistinctQualities: facts } }), []);
});

test('quality: a null series summary member stops the summary', t => {
  const h = page(t, { seriesQualityAggregation: 'latest' });
  assert.deepEqual(h.quality({ Type: 'Series', QualitySummary: { LatestExtras: ['IMAX', null], Categories: {} } }), []);
  assert.deepEqual(h.quality({ Type: 'Series', QualitySummary: { LatestExtras: ['IMAX'], Categories: { resolution: null } } }), []);
  assert.deepEqual(h.quality({ Type: 'Series', QualitySummary: { LatestExtras: ['IMAX', 'versions:2'], Categories: {} } }), ['IMAX']);
});

test('language: a null audio code aborts the group, the whole group', t => {
  const h = page(t);
  assert.equal(h.languages({ AudioLanguages: ['en', 'fr'] }).length, 2);
  assert.deepEqual(h.languages({ AudioLanguages: ['en', null] }), []);
  assert.deepEqual(h.languages({ AudioLanguages: [null, 'en'] }), []);
});

test('language: a language named after an Object.prototype member draws no group while it would show', t => {
  const h = page(t);
  assert.deepEqual(h.languages({ AudioLanguages: ['constructor', 'en'] }), []);
  assert.deepEqual(h.languages({ AudioLanguages: ['toString', 'en'] }), []);
});

test('language: past the cap that token is not shown, so it stops nothing', t => {
  const h = page(t);
  assert.deepEqual(h.languages({ AudioLanguages: ['en', 'fr', 'de', 'constructor'] }), ['gb', 'fr', 'de']);
  const uncapped = page(t, { tagGroupCaps: { language: 0 } });
  assert.deepEqual(uncapped.languages({ AudioLanguages: ['en', 'fr', 'de', 'constructor'] }), []);
});

test('language: two languages sharing that token are one chip, so partial order cannot hide it', t => {
  const h = page(t);
  const languages = [{ code: 'xa', name: 'constructor', partial: true }, { code: 'en', name: 'English' }, { code: 'xb', name: 'constructor' }];
  const group = h.JE.core.languageTags.buildGroup(languages, 1);
  assert.equal(group.children.length, 0, 'the merged chip is complete, so it sorts first and is the one shown');
});

test('language: the codes style has no flag to fail on', t => {
  const h = page(t, { languageTagsStyle: 'codes' });
  assert.ok(h.languages({ AudioLanguages: ['constructor', 'en'] }).includes('en'));
});

test('language: a null stream or source ends the item path', t => {
  const track = { Type: 'Audio', Language: 'eng' };
  assert.equal(page(t).languages({ MediaStreams: [track] }, 'render').length, 1);
  assert.deepEqual(page(t).languages({ MediaStreams: [track, null] }, 'render'), []);
  assert.deepEqual(page(t).languages({ MediaSources: [{ MediaStreams: [track] }, null] }, 'render'), []);
});

test('genre: a null genre ends the group, and still counts as the item having genres', t => {
  const h = page(t);
  assert.deepEqual(h.genres({ Genres: ['Drama'] }), ['Drama']);
  assert.deepEqual(h.genres({ Genres: ['Drama', null] }), []);
  assert.deepEqual(h.genres({ Genres: ['Drama', null] }, 'render'), []);
});

test('quality: a null track inside the first version ends detection', t => {
  const h = page(t);
  assert.ok(h.quality(streamData([], [{ Path: 'movie.mkv', MediaStreams: [video] }])).includes('H264'));
  assert.deepEqual(page(t).quality(streamData([], [{ Path: 'movie.mkv', MediaStreams: [video, null] }])), []);
});

const settle = () => new Promise(resolve => setTimeout(resolve, 250));

test('styles: artwork colours follow whether the server listed groups, not what the list holds', async t => {
  for (const [groups, active] of [[[], false], [['genre'], true], [[null], true]]) {
    const seen = [];
    const h = createHarness({
      JE: { pluginConfig: { TagStyleWebActive: true }, currentSettings: {}, tagPosterColours: { setActive: value => seen.push(value) }, core: { ui: { injectCss() {}, removeCss() {} } } },
      apiClient: { getUrl: path => path, ajax: async () => ({ preset: 'dark', posterGroups: groups }) },
    });
    t.after(() => h.close());
    h.load('tags/tag-styles.js');
    h.JE.initializeTagStyles();
    await settle();
    assert.equal(seen.at(-1), active, JSON.stringify(groups));
  }
});

/** The real pipeline in batch mode over one Series card, with every answer given by hand. */
function batchPage(t, answer, needsFirstEpisode = false) {
  const drawn = [], io = { epoch: 0 };
  const h = createHarness({
    html: `<div class="card" data-id="${ID}" data-type="Series"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div></div></div>`,
    globals: { requestIdleCallback: fn => { fn({ timeRemaining: () => 50, didTimeout: true }); return 1; } },
    apiClient: {
      getCurrentUserId: () => 'user-a',
      ajax: ({ url, data }) => (url.includes('/tag-cache/') ? Promise.resolve({ items: {}, count: 0, version: 1, timestamp: 1 }) : answer(url, data ? JSON.parse(data) : null)),
    },
    JE: {
      pluginConfig: { TagCacheServerMode: false },
      currentSettings: { genreTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => io.epoch, isCurrent: value => value === io.epoch, onUserChange() {} },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} }, dom: { createObserver() {} } },
    },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.registerRenderer('genre', { render: (el, item, extras) => drawn.push(needsFirstEpisode ? extras.firstEpisode?.Id : item.Id), renderFromCache: () => false, isEnabled: () => true, needsFirstEpisode });
  h.JE.tagPipeline.initialize();
  return { ...h, drawn, io };
}

for (const [name, row] of [['a null row', null], ['a row without an id', { Type: 'Movie' }]]) {
  test(`pipeline: ${name} fails its batch rather than being drawn around`, async t => {
    const h = batchPage(t, async () => ({ Items: [{ Id: ID, Type: 'Movie' }, row], StripRevision: 'none' }));
    await settle();
    assert.deepEqual(h.drawn, []);
  });
}

test('pipeline: a whole batch answer still draws', async t => {
  const h = batchPage(t, async () => ({ Items: [{ Id: ID, Type: 'Movie' }], StripRevision: 'none' }));
  await settle();
  assert.deepEqual([...new Set(h.drawn)], [ID]);
});

test('pipeline: a batch answered after the session moved on draws nothing, even before its reset runs', async t => {
  let answer;
  const h = batchPage(t, () => new Promise(resolve => { answer = resolve; }));
  await settle();
  assert.equal(typeof answer, 'function', 'the batch is on its way');
  h.io.epoch++;
  answer({ Items: [{ Id: ID, Type: 'Movie' }], StripRevision: 'none' });
  await settle();
  assert.deepEqual(h.drawn, []);
});

test('pipeline: a first-episode answer starting with a null falls to the native lookup, not its second row', async t => {
  const h = batchPage(t, async (url, ids) => {
    if (!ids) return { Items: [{ Id: 'native', Type: 'Episode' }] };
    if (ids.includes(ID)) return { Items: [{ Id: ID, Type: 'Series', FirstEpisode: { Id: 'known', NeedsStreamFetch: true } }], StripRevision: 'none' };
    if (ids.includes('known')) return { Items: [null, { Id: 'second-row', Type: 'Episode' }] };
    return { Items: [] };
  }, true);
  await settle();
  assert.deepEqual([...new Set(h.drawn)], ['native']);
});
