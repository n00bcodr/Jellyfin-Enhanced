import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// Per-genre Tag Styles: each genre chip carries its canonical genre (data-je-genre), the
// stylesheet generator colours it by that label, and the admin editor offers one tile per genre.
// tests/fixtures/genre-styles.json is shared with the backend (native) and browser suites.
const fixture = JSON.parse(readFileSync(resolve(repositoryRoot, 'tests/fixtures/genre-styles.json'), 'utf8'));
const table = JSON.parse(readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/js/tags/genre-icons.json'), 'utf8'));
const rgb = (css) => {
  const [r, g, b, a] = css.match(/[\d.]+/g).map(Number);
  return a === undefined || a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
};

/**
 * genretags.js and tag-styles.js as the client loads them, with a captured pipeline.
 * @returns {Object} The harness, plus render(genres) → the chip elements.
 */
function client(t) {
  const h = createHarness({
    JE: {
      currentSettings: { genreTagsEnabled: true }, pluginConfig: {}, t: key => key,
      tagPipeline: { registerRenderer(name, renderer) { this[name] = renderer; }, clearProcessed() {}, scheduleScan() {} }
    }
  });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'tags/tag-styles.js', 'tags/genretags.js']) h.load(file);
  h.JE.initializeGenreTags();
  // The module's own stylesheet (the built-in colours), as the pipeline injects it.
  h.JE.tagPipeline.genre.injectCss();
  // Each render gets a card of its own (a card is tagged once).
  let cards = 0;
  const render = (genres) => {
    h.document.body.insertAdjacentHTML('beforeend', `<div class="card"><div class="cardScalable"><div class="je-tag-host" id="c${++cards}"></div></div></div>`);
    const host = h.document.getElementById(`c${cards}`);
    h.JE.tagPipeline.genre.renderFromServerCache(host, { Genres: genres });
    return [...host.querySelectorAll('.genre-tag')];
  };
  return { ...h, render };
}

test('the web genre table is generated from genre-icons.json, which native posters read', () => {
  execFileSync('python3', [resolve(repositoryRoot, 'scripts/generate_genre_labels.py'), '--check']);
  // One label per glyph: every glyph of every language belongs to exactly one canonical genre.
  const english = table.names.English;
  const owners = new Map(Object.keys(table.labels).map(key => [english[key], key]));
  assert.equal(owners.size, Object.keys(table.labels).length);
  for (const names of Object.values(table.names)) for (const icon of Object.values(names)) assert.ok(owners.has(icon), icon);
  assert.ok(!owners.has(table.defaultIcon));
});

test('every genre chip carries its canonical genre, aliases and translations included', t => {
  const h = client(t);
  for (const c of fixture.cases) {
    const [chip] = h.render([c.genre]);
    assert.equal(chip.dataset.jeGenre, c.label, c.genre);
    assert.equal(chip.querySelector('.je-msym-outlined').textContent, c.icon, c.genre);
    assert.equal(chip.title, c.genre);
    assert.equal(h.JE.genreTags.labelFor(c.genre), c.label);
  }
  // Every name of the table resolves to the label of the glyph it draws.
  for (const names of Object.values(table.names)) {
    for (const [name, icon] of Object.entries(names)) {
      const label = h.JE.genreTags.labelFor(name);
      if (name !== name.toLowerCase()) { assert.equal(label, 'other', name); continue; }
      assert.equal(table.names.English[label], icon, name);
    }
  }
});

test('the stylesheet colours each genre by its label, over the group colour and the built-in one', t => {
  const h = client(t);
  const chips = fixture.cases.map(c => h.render([c.genre])[0]);
  h.JE.core.ui.injectCss('je-tag-style-overrides', h.JE.tagStyles.buildCss({ genre: fixture.web }));
  fixture.cases.forEach((c, i) => {
    const style = h.window.getComputedStyle(chips[i]);
    assert.equal(style.backgroundColor, rgb(c.drawn.background), `${c.genre} background`);
    assert.equal(style.borderTopColor, rgb(c.drawn.border), `${c.genre} border`);
    assert.equal(style.color, rgb(c.drawn.text), `${c.genre} icon`);
  });
  const css = h.JE.tagStyles.buildCss({ genre: fixture.web });
  assert.match(css, /\.genre-overlay-container \.genre-tag\[data-je-genre="horror"\]:where\(:not\(\[data-je-tag-styles-scope\] \*\)\) \{ background-color: rgba\(198, 40, 40, 1\) !important;/);
  // The name beside the icon takes the chip's colours where it floats; inline in the hover reveal only the text colour.
  assert.match(css, /\[data-je-genre="horror"\] \.genre-text:where\(:not\(\[data-je-tag-styles-scope\] \*\)\) \{ color: rgba\(255, 255, 255, 1\) !important; \}/);
  assert.match(css, /\[data-je-genre="horror"\] \.genre-text:not\(\[data-je-slot="hover"\] \*\):where\(:not\(\[data-je-tag-styles-scope\] \*\)\) \{ background-color: rgba\(198, 40, 40, 1\) !important; \}/);
  assert.doesNotMatch(css, /data-je-genre="science fiction"/, 'genres without colours of their own get no rule');
});

test('an older single genre colour still styles every genre chip', t => {
  const h = client(t);
  const [chip] = h.render(['Horror']);
  h.JE.core.ui.injectCss('je-tag-style-overrides', h.JE.tagStyles.buildCss({ genre: { background: 'rgba(1, 2, 3, 1)', border: null, color: null } }));
  assert.equal(h.window.getComputedStyle(chip).backgroundColor, 'rgb(1, 2, 3)');
  assert.equal(h.JE.tagStyles.buildCss({ genre: null }), '');
  assert.equal(h.JE.tagStyles.buildCss({ genre: {} }), '');
});

test('under the Poster preset the genre name takes the sampled colours, and genre colours still win', t => {
  const h = client(t);
  const css = h.JE.tagStyles.buildCss({ preset: 'poster', genre: { horror: { background: 'rgba(198, 40, 40, 1)', border: null, color: null } } });
  const lines = css.split('\n');
  const poster = lines.findIndex(l => l.startsWith('[data-je-poster-colour] .genre-tag .genre-text:not'));
  const label = lines.findIndex(l => l.includes('[data-je-genre="horror"] .genre-text:not'));
  assert.ok(poster >= 0 && label > poster, 'the label rule comes after the sampled one of the same specificity');
  assert.match(lines[poster], /background-color: var\(--je-tag-bg\) !important/);
  assert.ok(lines.some(l => l.startsWith('[data-je-poster-colour] .genre-tag .genre-text:where') && l.includes('color: var(--je-tag-fg) !important')));
});

// ── The admin editor ──

const pal = (background, border, color) => ({ background, border, color });
const genreLabels = [...Object.entries(table.labels).map(([key, name]) => ({ key, name })), { key: 'other', name: 'Other' }];
const builtin = pal('rgba(10, 10, 10, 0.8)', 'rgba(255, 255, 255, 0.2)', 'rgba(224, 224, 224, 1)');
const catalog = {
  presets: ['default'],
  age: [],
  groups: { quality: [{ key: '4K', name: '4K' }], ageRating: [], rating: [{ key: 'community', name: 'Community' }], genre: genreLabels, status: [], language: [{ key: 'flag', name: 'Flag' }] },
  palettes: { default: Object.fromEntries([['quality:4K', pal('rgba(189, 5, 232, 0.949)', 'rgba(255, 255, 255, 0.149)', 'rgba(255, 255, 255, 1)')], ...genreLabels.map(l => [`genre:${l.key}`, builtin])]) },
  genreIcons: Object.fromEntries(genreLabels.map(l => [l.key, l.key === 'other' ? table.defaultIcon : table.names.English[l.key]]))
};

async function editor(t, json = '', preset = 'default') {
  const h = createHarness({
    html: '<div id="jeTaRoot"><input id="tagStylesEnabled" type="checkbox" checked><div id="tagStylesBody"></div></div>',
    JE: { t: key => `«${key}»` },
    apiClient: { ajax: async () => catalog }, globals: { jeCdnUrl: path => path }
  });
  t.after(() => h.close());
  h.window.HTMLCanvasElement.prototype.getContext = () => {
    let fill = '#000000';
    return { get fillStyle() { return fill; }, set fillStyle(v) { if (/^(#[0-9a-f]{6}|rgba?\([\d.,\s]+\))$/i.test(String(v).trim())) fill = String(v).trim().toLowerCase(); } };
  };
  h.load('tags/tag-styles.js');
  h.load('enhanced/admintags/tag-styles-editor.js');
  h.document.querySelector('#tagStylesBody').innerHTML = h.JE.adminTags.EDITOR_HTML;
  const ed = h.JE.adminTags.createTagStylesEditor(h.document.querySelector('#jeTaRoot'));
  ed.load(json, preset);
  await new Promise(r => setImmediate(r));
  const $ = sel => h.document.querySelector(sel);
  const $$ = sel => [...h.document.querySelectorAll(sel)];
  $('.je-ts-tab[data-group="genre"]').click();
  return { ...h, ed, $, $$ };
}

test('the genre tab shows Whole group then one named icon tile per genre, with a filter', async t => {
  const h = await editor(t);
  const tiles = h.$$('#tagStyleTargets .je-ts-target');
  assert.equal(tiles[0].dataset.label, '*', 'Whole group stays first');
  assert.deepEqual(tiles.slice(1).map(n => n.dataset.label), genreLabels.map(l => l.key));
  assert.ok(h.$('#tagStyleTargets').classList.contains('je-ts-targets-tiles'));
  const horror = h.$('.je-ts-target[data-label="horror"]');
  assert.equal(horror.title, 'Horror');
  assert.equal(horror.getAttribute('aria-label'), 'Horror');
  assert.equal(horror.querySelector('.je-ts-genre-glyph').textContent, 'skull');
  assert.equal(horror.querySelector('.je-ts-target-name').textContent, 'Horror');
  assert.equal(h.$('.je-ts-target[data-label="other"] .je-ts-genre-glyph').textContent, 'theaters');
  assert.equal(h.$('#tagStyleGroupNote').textContent, '«admin_tags_colours_genre_note»');

  // More than twelve labels: the filter box shows and narrows the tiles by name.
  const filter = h.$('#tagStyleTargetFilter');
  assert.equal(filter.hidden, false);
  assert.equal(filter.placeholder, '«admin_tags_colours_genre_filter»');
  filter.value = 'SCI';
  filter.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.deepEqual(h.$$('#tagStyleTargets .je-ts-target:not([hidden])').map(n => n.dataset.label), ['*', 'science fiction']);
  // Other groups keep their plain strip and no filter; switching back clears it.
  h.$('.je-ts-tab[data-group="quality"]').click();
  assert.equal(h.$('#tagStyleTargetFilter').hidden, true);
  assert.ok(!h.$('#tagStyleTargets').classList.contains('je-ts-targets-tiles'));
  assert.equal(h.$('.je-ts-target-name'), null);
  h.$('.je-ts-tab[data-group="genre"]').click();
  assert.equal(h.$$('#tagStyleTargets .je-ts-target:not([hidden])').length, genreLabels.length + 1);
});

test('one genre takes its own colours, its own contrast badge and its preview chips', async t => {
  const h = await editor(t);
  h.$('.je-ts-target[data-label="horror"]').click();
  h.$('.je-ts-field-row[data-field="background"] .je-ts-swatch[title="#ff6b6b"]').click();
  h.$('.je-ts-field-row[data-field="text"] .je-ts-swatch[title="#ffffff"]').click();
  h.$('.je-ts-target[data-label="comedy"]').click();
  h.$('.je-ts-field-row[data-field="background"] .je-ts-swatch[title="#ffd166"]').click();
  const saved = JSON.parse(h.ed.serialize());
  assert.deepEqual(Object.keys(saved.labels), ['genre:comedy', 'genre:horror'], 'in the order the server stores them');
  assert.equal(saved.labels['genre:horror'].background.startsWith('rgba(255, 107, 107,'), true);
  assert.equal(saved.groups, undefined);
  assert.ok(h.$('.je-ts-target[data-label="horror"]').classList.contains('changed'));
  assert.ok(!h.$('.je-ts-target[data-label="drama"]').classList.contains('changed'));

  // Comedy's badge is its own: the built-in light grey icon on yellow reads poorly.
  assert.equal(h.$('.je-ts-contrast-badge').dataset.level, 'low');
  assert.equal(h.$('.je-ts-contrast-hint').textContent, 'Text over background, on a dark poster');
  h.$('.je-ts-target[data-label="drama"]').click();
  assert.equal(h.$('.je-ts-contrast-badge').dataset.level, 'aa');
  // Whole group: the worst genre, named.
  h.$('.je-ts-target[data-label="*"]').click();
  assert.match(h.$('.je-ts-contrast-hint').textContent, /\(Comedy\)/);

  // The preview shows a few genres, each through the generated stylesheet.
  const horror = h.$('#tagStylePreview .genre-overlay-container .genre-tag[data-je-genre="horror"]');
  assert.ok(horror && h.$('#tagStylePreview .genre-tag[data-je-genre="comedy"]') && h.$('#tagStylePreview .genre-tag[data-je-genre="animation"]'));
  assert.equal(horror.querySelector('.je-ts-genre-glyph').textContent, 'skull');
  assert.equal(h.window.getComputedStyle(horror).backgroundColor.startsWith('rgba(255, 107, 107,') || h.window.getComputedStyle(horror).backgroundColor === 'rgb(255, 107, 107)', true);
  assert.equal(h.window.getComputedStyle(h.$('#tagStylePreview .genre-tag[data-je-genre="animation"]')).backgroundColor, 'rgba(10, 10, 10, 0.8)');
});

test('a document with the old single genre label opens with it as the group colours and no unsaved change', async t => {
  const old = JSON.stringify({ v: 2, preset: 'default', groups: { genre: { border: 'rgba(0, 255, 0, 1)' } }, labels: { 'genre:genre': { background: 'rgba(255, 0, 0, 1)' }, 'quality:4K': { text: 'rgba(0, 0, 0, 1)' } } });
  const h = await editor(t, old);
  assert.equal(h.ed.snapshot(), `${old}|default`, 'loading alone changes nothing');
  assert.deepEqual(JSON.parse(h.ed.serialize()), { v: 2, preset: 'default', groups: { genre: { border: 'rgba(0, 255, 0, 1)', background: 'rgba(255, 0, 0, 1)' } }, labels: { 'quality:4K': { text: 'rgba(0, 0, 0, 1)' } } });
  assert.ok(h.$('.je-ts-target[data-label="*"]').classList.contains('changed'));
  // An edit is a real change from then on.
  h.$('.je-ts-target[data-label="horror"]').click();
  h.$('.je-ts-field-row[data-field="text"] .je-ts-swatch[title="#ffffff"]').click();
  assert.notEqual(h.ed.snapshot(), `${old}|default`);
});

test('the editor saves the document exactly as the server stores it, and a reload keeps the group being edited', async t => {
  // A save the server would store differently reads as normalised: the page loads the stored value
  // into the editor again. Before, labels in click order (and fields in pick order) did that on most
  // genre edits, and the reload sent the editor back to the Quality tab.
  const h = await editor(t);
  h.$('.je-ts-target[data-label="war"]').click();
  h.$('.je-ts-field-row[data-field="text"] .je-ts-swatch[title="#ffffff"]').click();
  h.$('.je-ts-field-row[data-field="background"] .je-ts-swatch[title="#1e88e5"]').click();
  h.$('.je-ts-target[data-label="action"]').click();
  h.$('.je-ts-field-row[data-field="border"] .je-ts-swatch[title="#ffffff"]').click();
  h.$('.je-ts-target[data-label="*"]').click();
  h.$('.je-ts-field-row[data-field="text"] .je-ts-swatch[title="#e0e0e0"]').click();
  const json = h.ed.serialize();
  // TagStyleSet.Serialize: keys in ordinal order, fields background, border, text.
  assert.match(json, /^\{"v":2,"preset":"default","groups":\{"genre":\{"text":[^}]+\}\},"labels":\{"genre:action":\{"border":[^}]+\},"genre:war":\{"background":"[^"]+","text":"[^"]+"\}\}\}$/);
  h.$('.je-ts-target[data-label="war"]').click();
  h.ed.load(json, 'default');
  assert.equal(h.$('.je-ts-tab.active').dataset.group, 'genre', 'the group stays');
  assert.equal(h.$('.je-ts-target.active').dataset.label, 'war', 'and so does the label');
  assert.equal(h.ed.serialize(), json);
  // Reset all (an empty document) keeps them too.
  h.$('.je-ts-tab[data-group="quality"]').click();
  h.$('.je-ts-target[data-label="4K"]').click();
  h.ed.load('', 'default');
  assert.equal(h.$('.je-ts-tab.active').dataset.group, 'quality');
  assert.equal(h.$('.je-ts-target.active').dataset.label, '4K');
});
