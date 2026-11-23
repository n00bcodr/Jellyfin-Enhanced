import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness } from '../helpers/harness.mjs';

// Tag text (#1063): the administrator sets the words a Tag Styles label's chips show, in TagTextOverrides (a JSON
// document); the web replaces the chip text where native posters do (TagTextRules / PosterTagResolver,
// tests/backend/Core/CoreTagTextOverridesTests.cs).

const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url)));
const CARD = '<div class="card" data-type="Movie" data-id="a"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Title</div></div></div>';

function setup(t, { settings = {}, overrides = null, files = [] } = {}) {
  const renderers = new Map();
  const h = createHarness({ html: CARD,
    JE: { currentSettings: { tagLayoutSettingsVersion: 1, ...settings }, pluginConfig: { TagTextOverrides: overrides },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), en[key] || key),
      session: { getUserId: () => 'a', getServerId: () => 's', onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} }, cdn: { url: (a, b) => `http://jf/${a}/${b}`, flagSvg: () => 'data:,' },
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (id, renderer) => renderers.set(id, renderer), getRenderer: (id) => renderers.get(id), clearProcessed() {}, scheduleScan() {} } },
    apiClient: { getUrl: (path) => `http://jf/${path}` },
    fetch: async () => ({ ok: true, text: async () => '' }) });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'extras/colored-ratings.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', ...files]) h.load(file);
  const host = h.document.querySelector('.je-tag-host');
  return { ...h, host,
    render(id, entry) { renderers.get(id).renderFromServerCache(host, entry, 'a'); h.JE.core.tagLayout.flushFit?.(); },
    shown: (selector) => [...host.querySelectorAll(`.je-tag-slot:not([data-je-slot="hover"]) ${selector}`)] };
}

test('the text comes from the public configuration, exact labels, and a bad document overrides nothing', t => {
  const h = setup(t, { overrides: JSON.stringify({ status: { milestone: 'End of Season' }, quality: { '4K': 'UHD' } }) });
  const T = h.JE.core.tagText;
  assert.equal(T.of('status', 'milestone'), 'End of Season');
  assert.equal(T.of('quality', '4k'), null, 'labels are exact');
  assert.equal(T.of('genre', 'drama'), null);
  h.JE.pluginConfig.TagTextOverrides = '{not json';
  assert.equal(T.of('status', 'milestone'), null);
  h.JE.pluginConfig.TagTextOverrides = null;
  assert.equal(T.of('quality', '4K'), null);
});

test('a genre label renames the genre text of every chip it colours and leaves the others', t => {
  const h = setup(t, { settings: { genreTagsEnabled: true }, overrides: JSON.stringify({ genre: { drama: 'Serious' } }), files: ['tags/genretags.js'] });
  h.JE.initializeGenreTags();
  h.render('genre', { Type: 'Movie', Genres: ['Fantasy', 'Drame'] });
  const texts = h.shown('.genre-tag').map((g) => g.querySelector('.genre-text').textContent);
  assert.deepEqual(texts, ['Fantasy', 'Serious']);
});

test('a quality label replaces the whole chip text and leaves the other chips', t => {
  const h = setup(t, { settings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', tagGroupCaps: { quality: 0 } }, overrides: JSON.stringify({ quality: { '4K': 'UHD' } }), files: ['tags/qualitytags.js'] });
  h.JE.initializeQualityTags();
  const entry = { Type: 'Movie', StreamData: { Sources: [{ Id: 'a' }], Streams: [{ Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, SourceId: 'a' }] } };
  h.render('quality', entry);
  const chips = h.shown('.quality-overlay-label');
  assert.equal(chips.find((c) => c.dataset.quality === '4K')?.textContent, 'UHD');
  assert.ok(chips.some((c) => c.dataset.quality !== '4K' && c.textContent !== 'UHD'), 'other chips keep their own text');
});
