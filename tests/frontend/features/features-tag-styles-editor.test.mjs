import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// The Tag Styles editor is an inline script of the config page: run the real
// markup and the real IIFE, cut out of configPage.html.
const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
const between = (from, to) => {
  const start = page.indexOf(from);
  const end = page.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} … ${to} not found in configPage.html`);
  return page.slice(start, end + to.length);
};
const contrastSource = between('// <tag-style-contrast>', '// </tag-style-contrast>');
const editorSource = between('        const tagStyles = (() => {', '            return { load, serialize, settings, renderTargetPills };\n        })();');
const markup = between('<div class="checkboxContainer"><label><input id="tagStylesEnabled"', '<div id="tagStylesBody">')
  + between('<div id="tagStyleEditor"', '<div class="je-setting-description" data-desc-for="tagStylesAllowUserPreset">') + '</div></div></div>';

const pal = (background, border, color) => ({ background, border, color });
// A tiny catalog in the server's shape: two presets, a few labels per group.
const catalog = {
  presets: ['default', 'glass'],
  age: [{ id: '9', ratings: ['PG-13', 'TV-14'], sample: 'PG-13' }, { id: '7', ratings: ['R'], sample: 'R' }],
  groups: {
    quality: [{ key: '4K', name: '4K' }, { key: 'HEVC', name: 'HEVC' }],
    ageRating: [{ key: '9', name: 'PG-13' }, { key: '7', name: 'R' }],
    rating: [{ key: 'community', name: 'Community' }, { key: 'critic', name: 'Critic' }, { key: 'userReview', name: 'User review' }],
    genre: [{ key: 'genre', name: 'Genre' }],
    status: [{ key: 'added', name: 'Just Added' }, { key: 'trending', name: 'Trending' }],
    language: [{ key: 'flag', name: 'Flag' }]
  },
  palettes: {
    default: {
      'quality:4K': pal('rgba(189, 5, 232, 0.949)', 'rgba(255, 255, 255, 0.149)', 'rgba(255, 255, 255, 1)'),
      'quality:HEVC': pal('rgba(33, 150, 243, 0.902)', 'rgba(255, 255, 255, 0.149)', 'rgba(255, 255, 255, 1)'),
      'rating:community': pal('rgba(0, 0, 0, 0.851)', 'rgba(0, 0, 0, 0)', 'rgba(255, 193, 7, 1)'),
      'ageRating:9': pal('rgba(230, 81, 0, 1)', 'rgba(255, 152, 0, 1)', 'rgba(255, 255, 255, 1)'),
      'language:flag': pal('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 1)')
    },
    glass: {
      'quality:4K': pal('rgba(255, 255, 255, 0.161)', 'rgba(255, 255, 255, 0.349)', 'rgba(255, 255, 255, 1)'),
      'quality:HEVC': pal('rgba(255, 255, 255, 0.161)', 'rgba(255, 255, 255, 0.349)', 'rgba(255, 255, 255, 1)'),
      'rating:community': pal('rgba(255, 255, 255, 0.161)', 'rgba(255, 255, 255, 0.349)', 'rgba(255, 209, 102, 1)'),
      'ageRating:9': pal('rgba(255, 255, 255, 0.161)', 'rgba(255, 255, 255, 0.349)', 'rgba(255, 255, 255, 1)'),
      'language:flag': pal('rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 0.349)', 'rgba(255, 255, 255, 1)')
    }
  }
};

/** The editor over its real markup, with the catalog answered locally. */
async function setup(t, json = '', preset = 'default') {
  const h = createHarness({ html: markup, apiClient: { ajax: async () => catalog }, globals: { jeCdnUrl: path => `http://jellyfin.test/cdn/${path}` } });
  t.after(() => h.close());
  h.window.eval(`window.__editor = (function () {\n${editorSource}\nreturn tagStyles; })();`);
  const editor = h.window.__editor;
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

test('a version 1 document loads onto labels and saves as version 2', async t => {
  const h = await setup(t, JSON.stringify({ quality: { '4K': { background: '#ff0000', color: '#0000ff' } }, age: { 9: { border: '#00ff00' } }, genre: { background: '#111111' } }), 'custom');
  const saved = JSON.parse(h.editor.serialize());
  assert.deepEqual(saved, {
    v: 2, preset: 'default',
    labels: {
      'quality:4K': { background: 'rgba(255, 0, 0, 1)', text: 'rgba(0, 0, 255, 1)' },
      'ageRating:9': { border: 'rgba(0, 255, 0, 1)' },
      'genre:genre': { background: 'rgba(17, 17, 17, 1)' }
    }
  });
  assert.ok(h.$('.je-ts-target[data-label="4K"]').classList.contains('changed'));
  assert.equal(h.$('.je-ts-target[data-label="4K"] .je-ts-chip').style.background, 'rgb(255, 0, 0)', 'drawn in its effective colours');
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
  assert.equal(h.$('.je-ts-card-movie .je-ts-corner-tl .je-ts-q').style.background, 'rgb(30, 136, 229)', 'the preview follows');
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

test('language edits only the border ring and reset all clears everything', async t => {
  const h = await setup(t, JSON.stringify({ v: 2, preset: 'glass', groups: { status: { text: 'rgba(0, 255, 0, 1)' } } }), 'glass');
  h.click('.je-ts-tab[data-group="language"]');
  assert.deepEqual(h.$$('.je-ts-field-row').map(r => r.dataset.field), ['border']);
  assert.equal(h.$('.je-ts-contrast').textContent, '', 'no text on a flag');
  assert.match(h.$('#tagStyleGroupNote').textContent, /border ring/);
  assert.equal(h.$('.je-ts-target[data-label="flag"] .je-ts-flag').style.outline, '1px solid rgba(255, 255, 255, 0.349)');

  h.click('#tagStyleResetAll');
  assert.equal(h.editor.serialize(), '');
  assert.equal(h.editor.settings().preset, 'default');

  // Apply-to pills drive the hidden TagStyleTarget value.
  h.click('#tagStyleTargetPills [data-target="native"]');
  assert.equal(h.$('#tagStyleTarget').value, 'native');
  assert.equal(h.$('#tagStyleTargetPills [data-target="native"]').getAttribute('aria-checked'), 'true');
});
