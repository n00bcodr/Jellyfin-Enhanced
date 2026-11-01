import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, BASE } from '../helpers/admin-tags-page.mjs';

const sheets = {
  statusTagsEnabled: 'jellyfin-enhanced-status-tags-css',
  qualityTagsEnabled: 'quality-tag-enhanced-style',
  ratingTagsEnabled: 'jellyfin-enhanced-rating-tags-css',
  ageRatingTagsEnabled: 'jellyfin-enhanced-age-rating-tags-css',
  languageTagsEnabled: 'language-tags-styles',
  genreTagsEnabled: 'genre-tags-styles',
  awardsTagsEnabled: 'je-awards-tags-css',
  logoTagsEnabled: 'jellyfin-enhanced-logo-tags-css',
  customTagsEnabled: 'jellyfin-enhanced-custom-tags-css',
};

/** Load every real base-style provider with all personal groups disabled. */
function setup(t, config = {}) {
  const server = { ...BASE, ...config };
  const h = boot(t, { server });
  const registered = [];
  h.JE.tagPipeline = { registerRenderer: name => registered.push(name) };
  for (const file of ['core/media-language.js', 'tags/tag-layout-styles.js', 'tags/status-vocabulary.js',
    'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/languagetags.js',
    'tags/genretags.js', 'tags/statustags.js', 'tags/awardstags.js', 'tags/logotags.js', 'tags/customtags.js',
    'enhanced/settingspanel/ui-panel-tag-preview.js']) h.load(file);
  Object.assign(h.JE.currentSettings, Object.fromEntries(Object.keys(sheets).map(key => [key, false])));
  const root = h.document.getElementById('jeTaRoot');
  const ctx = h.A.createPage(root, server);
  h.cleanup.push(() => ctx.dispose());
  return { ...h, root, ctx, registered };
}

for (const tab of ['overview', 'layout', 'groups', 'colours', 'badges']) {
  test(`admin ${tab} preview styles Status and Genre from server defaults with personal groups off`, async t => {
    const h = setup(t, { StatusTagsEnabled: true, GenreTagsEnabled: true });
    const own = h.JE.currentSettings, plugin = h.JE.pluginConfig;
    h.ctx.openTab(tab);
    const preview = h.root.querySelector('#jeTaPreviewBody');
    assert.ok(preview.querySelector('.status-tag--trending'));
    assert.ok(preview.querySelector('.genre-tag .je-msym-outlined'));
    assert.match(h.document.getElementById(sheets.statusTagsEnabled).textContent, /background-color: rgba\(15, 15, 15, 0.72\)/);
    assert.match(h.document.getElementById(sheets.genreTagsEnabled).textContent, /font-family: 'JE Material Symbols Outlined'/);
    assert.equal(h.JE.currentSettings, own);
    assert.equal(h.JE.pluginConfig, plugin);
    assert.equal(own.statusTagsEnabled, false);
    assert.equal(own.genreTagsEnabled, false);
    assert.deepEqual(h.registered, [], 'loading CSS must not start renderers or network work');
  });
}

test('draft group changes load styles before saving; reverse defaults hide groups; hub follows personal settings', async t => {
  const h = setup(t, { StatusTagsEnabled: false, GenreTagsEnabled: false });
  const preview = h.root.querySelector('#jeTaPreviewBody');
  Object.assign(h.JE.currentSettings, { statusTagsEnabled: true, genreTagsEnabled: true });
  assert.equal(preview.querySelector('.status-tag'), null, 'server off wins over personal on');
  assert.equal(preview.querySelector('.genre-tag'), null);
  // Hold autosave while animation frames redraw the unsaved draft.
  const timeout = h.window.setTimeout.bind(h.window);
  h.window.setTimeout = (fn, delay, ...args) => delay === 400 ? 0 : timeout(fn, delay, ...args);
  h.ctx.setMany({ StatusTagsEnabled: true, GenreTagsEnabled: true });
  h.ctx.preview.refresh();
  await new Promise(resolve => h.window.requestAnimationFrame(resolve));
  assert.ok(preview.querySelector('.status-tag'));
  assert.ok(preview.querySelector('.genre-tag'));
  assert.ok(h.document.getElementById(sheets.statusTagsEnabled));
  assert.ok(h.document.getElementById(sheets.genreTagsEnabled));
  assert.equal(h.patches.length, 0, 'draft is still unsaved');
  const mount = h.document.createElement('div'); h.root.appendChild(mount);
  Object.assign(h.JE.currentSettings, { statusTagsEnabled: false, genreTagsEnabled: false });
  const hub = h.JE.internals.enhancedUi.createTagPreview(mount);
  h.cleanup.push(() => hub.dispose());
  assert.equal(mount.querySelector('.status-tag'), null);
  assert.equal(mount.querySelector('.genre-tag'), null);
  Object.assign(h.JE.currentSettings, { statusTagsEnabled: true, genreTagsEnabled: true });
  hub.refresh(); await new Promise(resolve => h.window.requestAnimationFrame(resolve));
  assert.ok(mount.querySelector('.status-tag'));
  assert.ok(mount.querySelector('.genre-tag'));
});

test('every enabled preview group has base styles without renderer activation or stylesheet replacement', t => {
  const h = setup(t);
  for (const id of Object.values(sheets)) h.document.getElementById(id)?.remove();
  h.JE.core.tagRenderer.ensureStyles(Object.fromEntries(Object.keys(sheets).map(key => [key, true])));
  for (const id of Object.values(sheets)) assert.ok(h.document.getElementById(id)?.textContent, id);
  const genre = h.document.getElementById(sheets.genreTagsEnabled);
  genre.textContent += '\n/* personal sheet retained */';
  h.JE.core.tagRenderer.ensureStyles({ genreTagsEnabled: true });
  assert.match(genre.textContent, /personal sheet retained/);
  assert.deepEqual(h.registered, []);
});
