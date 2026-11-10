import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, plain, jsRoot } from '../../helpers/harness.mjs';

function setup(t, settings = {}, plugin = {}) {
  const renderers = new Map();
  const h = createHarness({ html: '<div class="card" data-type="Movie"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div></div>',
    JE: { currentSettings: { ratingTagsEnabled: true, ...settings }, pluginConfig: plugin, t: key => key,
      tagPipeline: { registerRenderer: (id, renderer) => renderers.set(id, renderer), getRenderer: id => renderers.get(id), clearProcessed() {}, scheduleScan() {} } } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/rating-sources.js', 'tags/ratingtags.js']) h.load(file);
  h.JE.initializeRatingTags();
  const host = h.document.querySelector('.je-tag-host');
  return { ...h, host, render(entry) { renderers.get('rating').renderFromServerCache(host, entry, 'item'); },
    batch(item) { renderers.get('rating').render(host, item, {}); },
    chips: () => [...host.querySelectorAll('.rating-tag')], facts: h.JE.ratingSources };
}
const ratings = { imdb: 8.1, tmdb: 81, rtCritic: 92, rtAudience: 88, metacritic: 74, letterboxd: 4.1, trakt: 85 };

test('all seven sources keep configured order, native units, bundled logos and style labels', t => {
  const sources = Object.keys(ratings).reverse();
  const h = setup(t, { ratingTagsSources: sources });
  h.render({ Type: 'Movie', Ratings: ratings });
  assert.deepEqual(h.chips().map(el => el.dataset.jeRatingSource), sources);
  assert.deepEqual(h.chips().map(el => el.querySelector('.rating-text').textContent), ['85%', '4.1', '74', '88%', '92%', '81%', '8.1']);
  for (const el of h.chips()) {
    assert.ok(el.matches('.rating-tag.rating-tag--source'));
    assert.ok(el.querySelector('svg path'));
    assert.equal(el.querySelector('img'), null);
    assert.equal(el.getAttribute('aria-label'), h.facts.name(el.dataset.jeRatingSource) + ': ' + el.querySelector('.rating-text').textContent);
  }
});

// MyAnimeList, AniList, Metacritic user, Roger Ebert and MDBList's own score come in MDBList's answer too.
const added = { myAnimeList: 8.4, aniList: 82, metacriticUser: 7.9, rogerEbert: 3.5, mdblist: 78 };

test('the five further MDBList sources draw on their own scales with their names, colours and bundled logos', t => {
  const sources = Object.keys(added);
  const h = setup(t, { ratingTagsSources: sources });
  assert.deepEqual(plain(h.facts.IDS).slice(-5), sources, 'offered after the first nine, in the built-in order');
  assert.deepEqual(plain(h.facts.normalizeSources(['mdblist', 'bogus', 'aniList'])), ['mdblist', 'aniList']);
  h.render({ Type: 'Movie', Ratings: added });
  assert.deepEqual(h.chips().map(el => el.dataset.jeRatingSource), sources);
  // Out of 10, 100, 10, 4 and 100.
  assert.deepEqual(h.chips().map(el => el.querySelector('.rating-text').textContent), ['8.4', '82%', '7.9', '3.5', '78%']);
  assert.deepEqual(h.chips().map(el => el.getAttribute('aria-label')), ['MyAnimeList: 8.4', 'AniList: 82%', 'Metacritic user: 7.9', 'Roger Ebert: 3.5', 'MDBList: 78%']);
  assert.deepEqual(h.chips().map(el => el.style.getPropertyValue('--je-rating-source-color')), ['#2e51a2', '#02a9ff', '#00ce7a', '#e8a33d', '#4aa3df']);
  for (const el of h.chips()) {
    assert.ok(el.matches('.rating-tag.rating-tag--source'));
    assert.ok(el.querySelector('svg path'), 'the inline logo where the plugin\'s asset route is not available');
  }
});

test('the further sources compare on the scale of ten, are held to their own maximum, and load their bundled image', t => {
  const h = setup(t, { ratingTagsSources: Object.keys(added), ratingTagsMinScore: 8 });
  // 8.4, 8.2, 7.9, 8.75 (3.5 of 4) and 7.8 out of ten.
  h.render({ Type: 'Movie', Ratings: added });
  assert.deepEqual(h.chips().map(el => el.dataset.jeRatingSource), ['myAnimeList', 'aniList', 'rogerEbert']);
  const conf = { sources: ['myAnimeList', 'metacriticUser', 'rogerEbert'], minimum: 0, color: true };
  const over = plain(h.facts.resolve(null, null, { myAnimeList: 12, metacriticUser: 11, rogerEbert: 5 }, conf));
  assert.deepEqual(over.map(f => f.text), ['10.0', '10.0', '4.0']);
  assert.equal(plain(h.facts.resolve(null, null, { rogerEbert: 2 }, conf))[0].color, h.facts.scoreColor(5), 'two of four stars is five of ten');
  // With the plugin's asset route each chip shows the bundled MDBList image of its source.
  h.JE.cdn = { url: (bucket, file) => `/cdn/${bucket}/${file}` };
  const files = Object.keys(added).map(id => h.facts.chip({ id, value: added[id], text: String(added[id]), color: null }).querySelector('img').getAttribute('src'));
  assert.deepEqual(files, ['myanimelist.png', 'anilist.png', 'metacritic_audience.png', 'rogerebert.png', 'master.png'].map(file => '/cdn/mdblist-logos/' + file));
});

test('normalization drops unknown ids and duplicates and keeps empty, zero and missing distinct', t => {
  const h = setup(t);
  assert.deepEqual(plain(h.facts.normalizeSources(['imdb', 'bogus', 'imdb', 'tmdb'])), ['imdb', 'tmdb']);
  assert.deepEqual(plain(h.facts.normalizeSources([])), []);
  assert.equal(h.facts.normalizeSources('imdb'), null);
  const conf = { sources: ['imdb', 'letterboxd', 'trakt'], minimum: 0, color: false };
  assert.deepEqual(plain(h.facts.resolve(null, null, { imdb: 0, letterboxd: null, trakt: 'NaN' }, conf)).map(f => f.text), ['0.0']);
  assert.deepEqual(plain(h.facts.settings({ ratingTagsMinScore: -1 }).minimum), 0);
  assert.equal(h.facts.settings({ ratingTagsMinScore: Infinity }).minimum, 0);
});

test('minimum uses a scale of ten before ordered caps and score colours yield to explicit styles', t => {
  const h = setup(t, { ratingTagsSources: ['metacritic', 'letterboxd', 'imdb', 'tmdb'], ratingTagsMinScore: 8,
    ratingTagsColorByScore: true, tagGroupCaps: { rating: 2 }, tagLayoutSettingsVersion: 1 });
  h.render({ Type: 'Movie', Ratings: ratings });
  assert.deepEqual(h.chips().map(el => el.dataset.jeRatingSource), ['letterboxd', 'imdb']);
  assert.equal(h.chips()[0].style.color, 'rgb(102, 187, 106)');
  h.load('tags/tag-styles.js');
  // Production style output uses !important, while score colouring is an ordinary inline declaration.
  assert.ok(h.chips()[0].style.getPropertyPriority('color') === '');
  const css = h.JE.tagStyles.buildCss({ rating: { imdb: { color: 'rgba(255, 0, 255, 1)' } } });
  assert.match(css, /\[data-je-rating-source="imdb"\].*color: rgba\(255, 0, 255, 1\) !important/);
  assert.equal(h.facts.scoreColor(4.9), '#ef5350');
  assert.equal(h.facts.scoreColor(5), '#ffb300');
  assert.equal(h.facts.scoreColor(7.5), '#66bb6a');
});

test('compact source chips retain values and a source dot, and batch DTOs render the same facts', t => {
  const h = setup(t, { ratingTagsSources: ['imdb', 'tmdb'], tagLabelDensity: 'compact', tagLayoutSettingsVersion: 1 });
  h.batch({ Id: 'item', Type: 'Movie', Ratings: ratings });
  assert.equal(h.chips().length, 2);
  for (const el of h.chips()) assert.equal(el.dataset.jeRatingCompact, '1');
  assert.match(h.document.getElementById('jellyfin-enhanced-rating-tags-css').textContent, /width: calc\(2px \* var\(--je-tag-scale, 1\)\); height: calc\(2px \* var\(--je-tag-scale, 1\)\)/);
});

test('Spoiler Guard suppresses sources on series and local fallback cache without restoring shared ratings', t => {
  const h = setup(t, { ratingTagsSources: ['imdb'] }, { SpoilerBlurEnabled: true });
  h.document.querySelector('.card').dataset.type = 'Series';
  h.JE.spoilerBlur = { isEnabledFor: () => true, isLoadOk: () => true, isLoaded: () => true };
  h.render({ Type: 'Series', Ratings: ratings });
  assert.equal(h.chips().length, 0);
});

test('every persistent tag entry schema matches the server constant, including IndexedDB restore', () => {
  const server = readFileSync(`${jsRoot}/../Features/MediaTags/Services/TagCache/TagCacheService.cs`, 'utf8');
  const schema = server.match(/CurrentCacheSchemaVersion = (\d+);/)[1];
  for (const file of ['tags/tag-cache-store.js', 'tags/tag-pipeline.js']) {
    assert.match(readFileSync(`${jsRoot}/${file}`, 'utf8'), new RegExp(`const (?:ENTRY_SCHEMA|STORED_ENTRY_SCHEMA) = (?:JE\\.tagCacheStore\\?\\.ENTRY_SCHEMA \\?\\? )?${schema};`));
  }
});

test('tag cache reference docs name the schema number in exactly one place', () => {
  const server = readFileSync(`${jsRoot}/../Features/MediaTags/Services/TagCache/TagCacheService.cs`, 'utf8');
  const schema = Number(server.match(/CurrentCacheSchemaVersion = (\d+);/)[1]);
  const numbered = [];
  for (const file of ['advanced/api.md', 'advanced/project-structure.md', 'enhanced/tags.md']) {
    const doc = readFileSync(`${jsRoot}/../../docs/${file}`, 'utf8');
    for (const match of doc.matchAll(/[Ss]chema (\d+)/g)) numbered.push(`${file}: ${match[0]}`);
    if (file !== 'advanced/api.md') assert.match(doc, /current (?:tag )?cache schema \(`CurrentCacheSchemaVersion`/, `${file} points to the model constant`);
  }
  // A schema bump updates this one sentence; every other reference names the constant.
  assert.deepEqual(numbered, [`advanced/api.md: Schema ${schema}`]);
  const api = readFileSync(`${jsRoot}/../../docs/advanced/api.md`, 'utf8');
  assert.ok(api.includes(`Schema ${schema} invalidates older disk and IndexedDB copies`));
});
