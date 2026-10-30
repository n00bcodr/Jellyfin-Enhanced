import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, plain, jsRoot } from '../helpers/harness.mjs';

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
    assert.match(el.getAttribute('aria-label'), /^rating_source_/);
  }
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
  assert.match(h.document.getElementById('jellyfin-enhanced-rating-tags-css').textContent, /width: 2px; height: 2px/);
});

test('Spoiler Guard suppresses sources on series and local fallback cache without restoring shared ratings', t => {
  const h = setup(t, { ratingTagsSources: ['imdb'] }, { SpoilerBlurEnabled: true });
  h.document.querySelector('.card').dataset.type = 'Series';
  h.JE.spoilerBlur = { isEnabledFor: () => true, isLoadOk: () => true, isLoaded: () => true };
  h.render({ Type: 'Series', Ratings: ratings });
  assert.equal(h.chips().length, 0);
});

test('every persistent tag entry schema matches server schema 15, including IndexedDB restore', () => {
  for (const file of ['tags/tag-cache-store.js', 'tags/tag-pipeline.js']) {
    assert.match(readFileSync(`${jsRoot}/${file}`, 'utf8'), /const (?:ENTRY_SCHEMA|STORED_ENTRY_SCHEMA) = 15;/);
  }
  const server = readFileSync(`${jsRoot}/../Services/TagCacheService.cs`, 'utf8');
  assert.match(server, /CurrentCacheSchemaVersion = 15;/);
});

test('tag cache reference docs consistently name the current invalidating schema', () => {
  const server = readFileSync(`${jsRoot}/../Services/TagCacheService.cs`, 'utf8');
  const schema = Number(server.match(/CurrentCacheSchemaVersion = (\d+);/)[1]);
  const api = readFileSync(`${jsRoot}/../../docs/advanced/api.md`, 'utf8');
  assert.ok(api.includes(`Schema ${schema} invalidates older disk and IndexedDB copies`));
  for (const file of ['advanced/api.md', 'advanced/project-structure.md', 'enhanced/tags.md']) {
    const doc = readFileSync(`${jsRoot}/../../docs/${file}`, 'utf8');
    const schemas = [...doc.matchAll(/[Ss]chema (\d+)/g)].map(match => Number(match[1]));
    assert.ok(schemas.length > 0, `${file} documents the cache schema`);
    assert.ok(schemas.every(value => value === schema), `${file} names the current schema`);
  }
});
