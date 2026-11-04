import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// The Tag Styles editor lives on the Media Tags admin page
// (js/enhanced/admintags/tag-styles-editor.js): run the real module over its
// own markup.
const source = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/js/enhanced/admintags/tag-styles-editor.js'), 'utf8');
const between = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} … ${to} not found in tag-styles-editor.js`);
  return source.slice(start, end + to.length);
};
const contrastSource = between('// <tag-style-contrast>', '// </tag-style-contrast>');
const markup = '<div id="jeTaRoot"><input id="tagStylesEnabled" type="checkbox" checked><div id="tagStylesBody"></div></div>';

/**
 * Build the editor in a harness: load the module, put its markup in the page
 * and create it over the page root.
 * @param {ReturnType<typeof createHarness>} h
 * @returns {Object} The editor.
 */
function createEditor(h) {
  h.load('enhanced/admintags/tag-styles-editor.js');
  h.document.querySelector('#tagStylesBody').innerHTML = h.JE.adminTags.EDITOR_HTML;
  return h.JE.adminTags.createTagStylesEditor(h.document.querySelector('#jeTaRoot'));
}

const pal = (background, border, color) => ({ background, border, color });
// A tiny catalog in the server's shape: two presets, a few labels per group.
const catalog = {
  presets: ['default', 'glass'],
  age: [{ id: '9', ratings: ['PG-13', 'TV-14'], sample: 'PG-13' }, { id: '7', ratings: ['R'], sample: 'R' }],
  groups: {
    quality: [{ key: '4K', name: '4K' }, { key: 'HEVC', name: 'HEVC' }],
    ageRating: [{ key: '9', name: 'PG-13' }, { key: '7', name: 'R' }],
    rating: [{ key: 'community', name: 'Community' }, { key: 'critic', name: 'Critic' }, { key: 'userReview', name: 'User review' }],
    genre: [{ key: 'horror', name: 'Horror' }, { key: 'comedy', name: 'Comedy' }, { key: 'animation', name: 'Animation' }, { key: 'drama', name: 'Drama' }, { key: 'other', name: 'Other' }],
    status: [{ key: 'added', name: 'Just Added' }, { key: 'newEpisode', name: 'New Episode' }, { key: 'trending', name: 'Trending' }],
    language: [{ key: 'flag', name: 'Flag' }]
  },
  palettes: {
    default: {
      'quality:4K': pal('rgba(189, 5, 232, 0.949)', 'rgba(255, 255, 255, 0.149)', 'rgba(255, 255, 255, 1)'),
      'quality:HEVC': pal('rgba(33, 150, 243, 0.902)', 'rgba(255, 255, 255, 0.149)', 'rgba(255, 255, 255, 1)'),
      'rating:community': pal('rgba(0, 0, 0, 0.851)', 'rgba(0, 0, 0, 0)', 'rgba(255, 193, 7, 1)'),
      'ageRating:9': pal('rgba(230, 81, 0, 1)', 'rgba(255, 152, 0, 1)', 'rgba(255, 255, 255, 1)'),
      ...Object.fromEntries(['horror', 'comedy', 'animation', 'drama', 'other'].map(k => [`genre:${k}`, pal('rgba(10, 10, 10, 0.8)', 'rgba(255, 255, 255, 0.2)', 'rgba(224, 224, 224, 1)')])),
      'language:flag': pal('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 1)')
    },
    glass: {
      'quality:4K': pal('rgba(255, 255, 255, 0.161)', 'rgba(255, 255, 255, 0.349)', 'rgba(255, 255, 255, 1)'),
      'quality:HEVC': pal('rgba(255, 255, 255, 0.161)', 'rgba(255, 255, 255, 0.349)', 'rgba(255, 255, 255, 1)'),
      'rating:community': pal('rgba(255, 255, 255, 0.161)', 'rgba(255, 255, 255, 0.349)', 'rgba(255, 209, 102, 1)'),
      'ageRating:9': pal('rgba(255, 255, 255, 0.161)', 'rgba(255, 255, 255, 0.349)', 'rgba(255, 255, 255, 1)'),
      'language:flag': pal('rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0.349)', 'rgba(255, 255, 255, 1)')
    }
  },
  genreIcons: { horror: 'skull', comedy: 'mood', animation: 'animation', drama: 'theater_comedy', other: 'theaters' }
};

// New source labels use the server's native-unit sample formats.
for (const [key, name] of [['imdb','IMDb'], ['tmdb','TMDb'], ['rtCritic','RT critic'], ['rtAudience','RT audience'], ['metacritic','Metacritic'], ['letterboxd','Letterboxd'], ['trakt','Trakt']]) {
  catalog.groups.rating.push({ key, name });
  for (const preset of catalog.presets) catalog.palettes[preset]['rating:' + key] = pal('rgba(0, 0, 0, 0.8)', 'rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 1)');
}

/**
 * jsdom has no canvas: a 2D context whose fillStyle, like a browser's, takes hex and rgb() colours
 * and keeps its previous value for anything else.
 */
function fakeCanvas(window) {
  window.HTMLCanvasElement.prototype.getContext = () => {
    let fill = '#000000';
    return {
      get fillStyle() { return fill; },
      set fillStyle(v) { if (/^(#[0-9a-f]{6}|rgba?\([\d.,\s]+\))$/i.test(String(v).trim())) fill = String(v).trim().toLowerCase(); }
    };
  };
}

/**
 * The editor over its real markup, with the catalog answered locally. The web
 * client's tag-styles.js is loaded too (as on the dashboard), unless `generator`
 * is false: the preview styles itself with its buildCss.
 */
async function setup(t, json = '', preset = 'default', { generator = true, cat = catalog, poster = false } = {}) {
  const h = createHarness({ html: markup, apiClient: { ajax: async () => cat }, globals: { jeCdnUrl: path => `http://jellyfin.test/cdn/${path}` } });
  t.after(() => h.close());
  fakeCanvas(h.window);
  if (generator) h.load('tags/tag-styles.js');
  if (poster) h.load('tags/tag-poster-colours.js');
  const editor = createEditor(h);
  editor.load(json, preset);
  await new Promise(resolve => setImmediate(resolve));
  const $ = sel => h.document.querySelector(sel);
  const click = sel => { const n = $(sel); assert.ok(n, `${sel} exists`); n.click(); };
  return { ...h, editor, $, click, $$: sel => [...h.document.querySelectorAll(sel)] };
}

test('the contrast helpers composite over the dark poster and grade like WCAG', () => {
  const api = new Function(`${contrastSource}\nreturn { rgbaOf, compositeOver, luminance, contrastRatio, contrastLevel };`)();
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} ≈ ${expected}`);
  near(api.contrastRatio('#ffffff', '#000000'), 21);
  near(api.contrastRatio('#767676', '#ffffff'), 4.54);
  near(api.contrastRatio('#949494', '#ffffff'), 3.03);
  near(api.contrastRatio('#ffffff', 'rgba(255, 255, 255, 0)'), 15.13); // a clear chip shows the #262626 poster
  near(api.contrastRatio('#ffffff', 'rgba(255, 255, 255, 0.92)'), 1.16);
  assert.equal(api.contrastRatio('url(x)', '#000000'), null);
  assert.deepEqual(api.contrastLevel(4.5), { level: 'aa', label: 'AA' });
  assert.deepEqual(api.contrastLevel(3), { level: 'large', label: 'AA large only' });
  assert.deepEqual(api.contrastLevel(2.99), { level: 'low', label: 'Low contrast' });
  assert.deepEqual(api.rgbaOf('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
});

test('a version 1 document migrates to the colours it drew and saves as version 2', async t => {
  // As the old editor stored it: only differences from the built-ins (a preset's kept fields left out),
  // with the preset name kept for its dropdown.
  const v1 = {
    quality: { '4K': { background: '#ff0000', color: '#0000ff' }, '8K-ULTRA': { background: '#ff0000' }, ['__proto__']: { background: '#ff0000' } },
    age: { 9: { border: '#00ff00' } },
    rating: { community: { background: 'rgba(0, 0, 0, 0.5)', border: '#ffffff' }, critic: { color: 'url(x)' }, userReview: { color: '#ffffff' } },
    genre: { background: '#111111' }
  };
  const h = await setup(t, JSON.stringify(v1), 'glass');
  const saved = JSON.parse(h.editor.serialize());
  assert.deepEqual(saved, {
    v: 2, preset: 'default',
    labels: {
      // Stored fields, else the built-in colour (catalog default palette); unknown labels and
      // values that are not colours are dropped, and rating chips never drew a border.
      'quality:4K': { background: 'rgba(255, 0, 0, 1)', border: 'rgba(255, 255, 255, 0.149)', text: 'rgba(0, 0, 255, 1)' },
      'ageRating:9': { background: 'rgba(230, 81, 0, 1)', border: 'rgba(0, 255, 0, 1)', text: 'rgba(255, 255, 255, 1)' },
      'rating:community': { background: 'rgba(0, 0, 0, 0.5)', text: 'rgba(255, 193, 7, 1)' }
    },
    // Version 1 coloured every genre chip alike: the genre group, under each genre's own colours.
    groups: { genre: { background: 'rgba(17, 17, 17, 1)', border: 'rgba(255, 255, 255, 0.2)', text: 'rgba(224, 224, 224, 1)' } }
  });
  assert.equal(h.editor.settings().preset, 'default', 'the saved preset name recolours nothing');
  assert.equal(h.$('.je-ts-preset[data-preset="default"]').getAttribute('aria-checked'), 'true');
  assert.ok(h.$('.je-ts-target[data-label="4K"]').classList.contains('changed'));
  assert.equal(h.$('.je-ts-target[data-label="4K"] .je-ts-chip').style.background, 'rgb(255, 0, 0)', 'drawn in its effective colours');
  // HEVC was not stored: it keeps its built-in colours, not Glass's.
  assert.equal(h.$('.je-ts-target[data-label="HEVC"] .je-ts-chip').style.background, 'rgba(33, 150, 243, 0.902)');
});

test('a version 1 document waits for the catalog and is handed back untouched until then', async t => {
  const v1 = JSON.stringify({ quality: { '4K': { background: '#ff0000' } } });
  let answer;
  const h = createHarness({ html: markup, apiClient: { ajax: () => new Promise(resolve => { answer = resolve; }) }, globals: { jeCdnUrl: path => path } });
  t.after(() => h.close());
  fakeCanvas(h.window);
  const editor = createEditor(h);
  editor.load(v1, 'glass');
  assert.equal(editor.serialize(), v1, 'the server migrates it the same way');
  assert.equal(editor.settings().preset, 'default');
  answer(catalog);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(editor.serialize()).labels['quality:4K'].border, 'rgba(255, 255, 255, 0.149)');
});

test('presets apply at once, tiles preview their palette and overrides survive a preset change', async t => {
  const h = await setup(t);
  assert.equal(h.$$('.je-ts-preset').length, 2);
  assert.equal(h.$('.je-ts-preset[data-preset="glass"] .je-ts-q').style.background, 'rgba(255, 255, 255, 0.161)');
  assert.equal(h.$('.je-ts-preset[data-preset="glass"] .je-ts-age').textContent, 'PG-13');

  // Whole group: labels differ, so the swatch shows "varies" and fading needs a colour first.
  assert.ok(h.$('.je-ts-field-row[data-field="background"] .je-ts-swatch-current').classList.contains('je-ts-swatch-varies'));
  assert.equal(h.$('.je-ts-field-row[data-field="background"] .je-ts-opacity-pill').disabled, true);
  assert.match(h.$('.je-ts-contrast-hint').textContent, /Lowest in the group/);
  // A swatch writes groups.quality.
  h.$('.je-ts-field-row[data-field="background"] .je-ts-swatch[title="#1e88e5"]').click();
  // One label: the text row writes labels['quality:HEVC'].
  h.click('.je-ts-target[data-label="HEVC"]');
  h.$('.je-ts-field-row[data-field="text"] .je-ts-swatch[title="#111111"]').click();
  h.click('.je-ts-preset[data-preset="glass"]');
  assert.equal(h.$('.je-ts-preset[data-preset="glass"]').getAttribute('aria-checked'), 'true');
  const saved = JSON.parse(h.editor.serialize());
  assert.equal(saved.preset, 'glass');
  assert.equal(saved.groups.quality.background, 'rgba(30, 136, 229, 1)');
  assert.deepEqual(saved.labels['quality:HEVC'], { text: 'rgba(17, 17, 17, 1)' });
  assert.equal(h.editor.settings().preset, 'glass');

  // Precedence in the drawn chips: label text over the group background over glass.
  const hevc = h.$('.je-ts-target[data-label="HEVC"] .je-ts-chip');
  assert.equal(hevc.style.background, 'rgb(30, 136, 229)');
  assert.equal(hevc.style.color, 'rgb(17, 17, 17)');
  assert.equal(hevc.style.borderColor, 'rgba(255, 255, 255, 0.349)');
  assert.equal(h.window.getComputedStyle(h.$('.je-ts-card-movie .je-ts-corner-tl .quality-overlay-label')).backgroundColor, 'rgb(30, 136, 229)', 'the preview follows');
});

test('opacity pills, Default buttons and the contrast badge follow the editing target', async t => {
  const h = await setup(t);
  h.click('.je-ts-target[data-label="4K"]');
  h.$('.je-ts-field-row[data-field="background"] .je-ts-swatch[title="#ffffff"]').click();
  assert.equal(h.$('.je-ts-contrast-badge').dataset.level, 'low', 'white on a near-white chip');
  h.$$('.je-ts-field-row[data-field="background"] .je-ts-opacity-pill').find(b => b.textContent === '40%').click();
  assert.equal(JSON.parse(h.editor.serialize()).labels['quality:4K'].background, 'rgba(255, 255, 255, 0.4)');
  assert.equal(h.$('.je-ts-contrast-badge').dataset.level, 'large');
  h.$('.je-ts-field-row[data-field="background"] .je-ts-swatch[title="#111111"]').click();
  assert.equal(h.$('.je-ts-contrast-badge').dataset.level, 'aa');
  assert.match(h.$('.je-ts-contrast-badge').textContent, /^AA · \d+\.\d:1$/);
  const reset = h.$('.je-ts-field-row[data-field="background"] .je-ts-reset');
  assert.equal(reset.disabled, false);
  reset.click();
  assert.equal(h.editor.serialize(), '', 'back to the preset: nothing stored');
  assert.equal(h.$('.je-ts-field-row[data-field="background"] .je-ts-reset').disabled, true);
});

test('under Poster the Whole group badge covers labels set here as well as those taken from the artwork', async t => {
  const cat = { ...catalog, presets: [...catalog.presets, 'poster'], poster: { worstContrast: 4.5 } };
  // 4K fully set here, black on black; HEVC takes both colours from the artwork.
  const doc = { v: 2, preset: 'poster', labels: { 'quality:4K': { background: 'rgba(0, 0, 0, 1)', text: 'rgba(0, 0, 0, 1)' } } };
  const h = await setup(t, JSON.stringify(doc), 'poster', { cat, poster: true });
  const badge = () => h.$('.je-ts-contrast-badge');
  assert.equal(badge().textContent, 'Low contrast · 1.0:1', 'the fully set label reads worst');
  assert.equal(badge().dataset.poster, 'fixed');
  assert.match(h.$('.je-ts-contrast-hint').textContent, /^Lowest in the group \(4K\).*tags without their own take them from the poster/);
  // Each label alone: its own colours, or the worst case over any artwork.
  h.click('.je-ts-target[data-label="4K"]');
  assert.equal(badge().textContent, 'Low contrast · 1.0:1');
  h.click('.je-ts-target[data-label="HEVC"]');
  assert.equal(badge().textContent, 'AA · 4.5:1');
  assert.equal(badge().dataset.poster, 'worst');
  assert.match(h.$('.je-ts-contrast-hint').textContent, /^Worst case over any artwork/);
  // HEVC partly set here (dark text over the artwork's background), 4K made readable: the sweep's worst case wins.
  h.$('.je-ts-field-row[data-field="text"] .je-ts-swatch[title="#111111"]').click();
  const partly = Number(/([\d.]+):1$/.exec(badge().textContent)[1]);
  assert.ok(partly < 3, `dark text over some poster colours: ${partly}`);
  h.click('.je-ts-target[data-label="4K"]');
  h.$('.je-ts-field-row[data-field="text"] .je-ts-swatch[title="#ffffff"]').click();
  h.click('.je-ts-target[data-label="*"]');
  assert.equal(badge().textContent, `Low contrast · ${partly.toFixed(1)}:1`);
  assert.equal(badge().dataset.poster, 'worst');
});

test('language group edits chip colours, flag target keeps its border ring, and reset all clears everything', async t => {
  const h = await setup(t, JSON.stringify({ v: 2, preset: 'glass', groups: { status: { text: 'rgba(0, 255, 0, 1)' } } }), 'glass');
  h.click('.je-ts-tab[data-group="language"]');
  assert.deepEqual(h.$$('.je-ts-field-row').map(r => r.dataset.field), ['background', 'border', 'text']);
  h.click('.je-ts-target[data-label="flag"]');
  assert.deepEqual(h.$$('.je-ts-field-row').map(r => r.dataset.field), ['border']);
  assert.equal(h.$('.je-ts-contrast').textContent, '', 'no text on a flag');
  assert.match(h.$('#tagStyleGroupNote').textContent, /border ring/);
  assert.equal(h.$('.je-ts-target[data-label="flag"] .je-ts-flag').style.outline, '1px solid rgba(255, 255, 255, 0.349)');

  // Reset all colours (the Colours section: confirmation and undo) loads an empty document.
  h.editor.load('', 'default');
  assert.equal(h.editor.serialize(), '');
  assert.equal(h.editor.settings().preset, 'default');
});

test('an opacity-only edit is a change to save; redrawn pickers and a version 1 migration are not', async t => {
  const h = await setup(t, JSON.stringify({ v: 2, preset: 'default', labels: { 'quality:4K': { background: 'rgba(255, 255, 255, 1)' } } }));
  // The Colours section saves whenever the editor's snapshot changes.
  const snapshot = () => h.editor.snapshot();
  h.click('.je-ts-target[data-label="4K"]');
  const saved = snapshot();

  // Redrawing the rows (another target, another tab) changes the colour pickers' values, not the document.
  h.click('.je-ts-tab[data-group="rating"]');
  h.click('.je-ts-tab[data-group="quality"]');
  h.click('.je-ts-target[data-label="4K"]');
  assert.equal(snapshot(), saved, 'transient editor controls are not part of the snapshot');

  // 40% keeps the hex colour (so no <input> value changes): only the document says it changed.
  const picker = h.$('.je-ts-field-row[data-field="background"] .je-ts-any').value;
  h.$$('.je-ts-field-row[data-field="background"] .je-ts-opacity-pill').find(b => b.textContent === '40%').click();
  assert.equal(h.$('.je-ts-field-row[data-field="background"] .je-ts-any').value, picker);
  assert.notEqual(snapshot(), saved, 'a change to save');
  h.$$('.je-ts-field-row[data-field="background"] .je-ts-opacity-pill').find(b => b.textContent === '100%').click();
  assert.equal(snapshot(), saved, 'back to the saved colour: nothing to save');

  // The preset alone is part of it too.
  h.click('.je-ts-preset[data-preset="glass"]');
  assert.notEqual(snapshot(), saved);

  // A version 1 document migrated once the catalog arrives is not an unsaved change.
  let answer;
  const late = createHarness({ html: markup, apiClient: { ajax: () => new Promise(resolve => { answer = resolve; }) }, globals: { jeCdnUrl: path => path } });
  t.after(() => late.close());
  fakeCanvas(late.window);
  late.window.__editor = createEditor(late);
  const lateSnapshot = () => late.window.__editor.snapshot();
  late.window.__editor.load(JSON.stringify({ quality: { '4K': { background: '#ff0000' } } }), 'glass');
  const before = lateSnapshot();
  answer(catalog);
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(late.window.__editor.serialize(), JSON.stringify({ quality: { '4K': { background: '#ff0000' } } }), 'migrated');
  assert.equal(lateSnapshot(), before);
});

test('the preview is styled by the web stylesheet generator over production-shaped chips', async t => {
  const h = await setup(t);
  const preview = h.$('#tagStylePreview');
  assert.equal(preview.dataset.styles, 'generated');
  // Production shapes: container classes, data-quality, rating subclasses, data-je-status, the flag wrapper.
  assert.ok(h.$('#tagStylePreview .quality-overlay-container .quality-overlay-label[data-quality="4K"]'));
  assert.ok(h.$('#tagStylePreview .rating-overlay-container .rating-tag.rating-tag-tmdb .rating-star-icon'));
  assert.ok(h.$('#tagStylePreview .rating-overlay-container .rating-tag.rating-tag-critic'));
  assert.ok(h.$('#tagStylePreview .rating-overlay-container .rating-tag.rating-tag-userreview .je-userreview-icon'));
  assert.ok(h.$('#tagStylePreview .age-rating-overlay-container .age-rating-tag[rating="PG-13"]'));
  assert.ok(h.$('#tagStylePreview .status-overlay-container .status-tag[data-je-status="trending"] .status-tag-rank'));
  assert.ok(h.$('#tagStylePreview .genre-overlay-container .genre-tag'));
  assert.ok(h.$('#tagStylePreview .language-overlay-container img.language-flag'));
  assert.equal(h.$$('#tagStylePreview .je-ts-chip').filter(n => n.getAttribute('style')).length, 0, 'no inline colours');

  // A group override: a rule in the preview's stylesheet, limited to the preview, and the chip's computed colour.
  h.click('.je-ts-tab[data-group="status"]');
  h.$('.je-ts-field-row[data-field="text"] .je-ts-swatch[title="#2e7d32"]').click();
  h.$('.je-ts-field-row[data-field="background"] .je-ts-swatch[title="#111111"]').click();
  const sheet = h.$('#tagStylePreviewCss');
  assert.match(sheet.textContent, /#tagStylePreview \.status-overlay-container \.status-tag\[data-je-status="trending"\] \{ background-color: rgba\(17, 17, 17, 1\) !important;color: rgba\(46, 125, 50, 1\) !important;/);
  assert.ok([...sheet.textContent.split('\n')].every(rule => rule.startsWith('#tagStylePreview ')), 'every rule is scoped to the preview');
  const trending = h.$('#tagStylePreview .status-tag[data-je-status="trending"]');
  assert.equal(h.window.getComputedStyle(trending).color, 'rgb(46, 125, 50)');
  assert.equal(h.window.getComputedStyle(trending).backgroundColor, 'rgb(17, 17, 17)');
  assert.equal(h.window.getComputedStyle(h.$('#tagStylePreview .status-tag-rank')).color, 'rgb(46, 125, 50)');
  assert.equal(h.window.getComputedStyle(h.$('#tagStylePreview .status-tag[data-je-status="newEpisode"]')).color, 'rgb(46, 125, 50)');

  // A label override reaches only its chip; nothing outside the preview is styled.
  h.click('.je-ts-tab[data-group="rating"]');
  h.click('.je-ts-target[data-label="community"]');
  h.$('.je-ts-field-row[data-field="text"] .je-ts-swatch[title="#ff6b6b"]').click();
  assert.equal(h.window.getComputedStyle(h.$('#tagStylePreview .rating-tag-tmdb .rating-star-icon')).color, 'rgb(255, 107, 107)');
  h.document.body.insertAdjacentHTML('beforeend', '<div class="rating-overlay-container"><div class="rating-tag rating-tag-tmdb" id="outside">8.1</div></div>');
  assert.notEqual(h.window.getComputedStyle(h.$('#outside')).color, 'rgb(255, 107, 107)', 'unsaved colours stay in the preview');
});

test('without the web client on the page the preview paints the chips inline', async t => {
  const h = await setup(t, JSON.stringify({ v: 2, preset: 'default', groups: { quality: { background: 'rgba(30, 136, 229, 1)' } } }), 'default', { generator: false });
  assert.equal(h.$('#tagStylePreview').dataset.styles, 'inline');
  assert.equal(h.$('#tagStylePreviewCss'), null);
  assert.equal(h.$('#tagStylePreview .quality-overlay-label[data-quality="4K"]').style.background, 'rgb(30, 136, 229)');
});


test('all source labels use their own logo with the bundle and readable names without it', async t => {
  for (const bundled of [false, true]) {
    const h = await setup(t);
    if (bundled) { h.JE.t = key => key; h.load('tags/rating-sources.js'); }
    h.click('#tagStyleTabs [data-group="rating"]');
    const chips = h.$$('#tagStyleTargets .rating-tag--source');
    assert.equal(chips.length, 7);
    for (const chip of chips) {
      assert.ok(chip.dataset.jeRatingSource);
      assert.equal(!!chip.querySelector('svg'), bundled);
      assert.equal(chip.querySelector('.je-ts-tomato'), null, 'new labels never inherit the legacy critic icon');
      if (!bundled) assert.ok(chip.querySelector('.je-ts-source-name').textContent);
    }
  }
});

test('keyboard focus stays on the preset tile, tab, swatch or opacity pill that redrew its own strip; Default hands it to its row', async t => {
  const h = await setup(t);
  const focusClick = (sel) => { const n = h.$(sel); assert.ok(n, `${sel} exists`); n.focus(); n.click(); };
  focusClick('.je-ts-preset[data-preset="glass"]');
  assert.equal(h.document.activeElement, h.$('.je-ts-preset[data-preset="glass"]'), 'preset tile');
  focusClick('.je-ts-tab[data-group="rating"]');
  assert.equal(h.document.activeElement, h.$('.je-ts-tab[data-group="rating"]'), 'tab');
  focusClick('.je-ts-field-row[data-field="background"] .je-ts-swatch[title="#ffffff"]');
  assert.equal(h.document.activeElement, h.$('.je-ts-field-row[data-field="background"] .je-ts-swatch[title="#ffffff"]'), 'swatch');
  const pill = () => h.$$('.je-ts-field-row[data-field="background"] .je-ts-opacity-pill').find(b => b.textContent === '40%');
  pill().focus();
  pill().click();
  assert.equal(h.document.activeElement, pill(), 'opacity pill');
  focusClick('.je-ts-field-row[data-field="background"] .je-ts-reset');
  assert.equal(h.$('.je-ts-field-row[data-field="background"] .je-ts-reset').disabled, true);
  assert.ok(h.$('.je-ts-field-row[data-field="background"]').contains(h.document.activeElement), 'Default is disabled now: focus stays in its row');
});

test('dragging the any-colour picker keeps its input; the rows are redrawn when the pick is done, focus kept', async t => {
  const h = await setup(t);
  h.click('.je-ts-target[data-label="4K"]');
  const any = h.$('.je-ts-field-row[data-field="background"] .je-ts-any');
  any.focus();
  any.value = '#123456';
  any.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(any.isConnected, true, 'not replaced while picking');
  assert.match(JSON.parse(h.editor.serialize()).labels['quality:4K'].background, /^rgba\(18, 52, 86, /);
  any.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const again = h.$('.je-ts-field-row[data-field="background"] .je-ts-any');
  assert.equal(again.value, '#123456');
  assert.equal(h.document.activeElement, again, 'focus on the redrawn picker');
});

test('each colour property reads as its value, opens its palette on Change (one at a time) and is reached by arrow keys between groups', async t => {
  const h = await setup(t);
  const row = (field) => h.$(`.je-ts-field-row[data-field="${field}"]`);
  assert.equal(row('background').querySelector('.je-ts-value').textContent, 'Varies by label', 'a mixed group value is written out');
  assert.ok(Array.from(h.$$('.je-ts-field-body')).every((body) => body.hidden), 'palettes start closed');
  row('background').querySelector('.je-ts-edit').click();
  assert.equal(row('background').querySelector('.je-ts-field-body').hidden, false);
  assert.equal(row('background').querySelector('.je-ts-edit').getAttribute('aria-expanded'), 'true');
  row('border').querySelector('.je-ts-edit').click();
  assert.equal(row('background').querySelector('.je-ts-field-body').hidden, true, 'opening another closes the first');
  assert.equal(row('border').querySelector('.je-ts-field-body').hidden, false);
  assert.equal(row('border').querySelector('.je-ts-reset').getAttribute('aria-label'), 'Reset border');
  // The group strip has one Tab stop, and arrows choose the next group.
  const tabs = h.$$('.je-ts-tab');
  assert.deepEqual(tabs.map((tab) => tab.tabIndex), tabs.map((tab) => (tab.getAttribute('aria-selected') === 'true' ? 0 : -1)));
  const active = h.$('.je-ts-tab.active');
  active.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.notEqual(h.$('.je-ts-tab.active').dataset.group, active.dataset.group);
  assert.equal(h.$('#tagStyleGroupPanel').getAttribute('aria-labelledby'), h.$('.je-ts-tab.active').id);
});
