import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, plain, jsRoot } from '../helpers/harness.mjs';

const page = readFileSync(`${jsRoot}/../Configuration/configPage.html`, 'utf8');
const start = page.indexOf('        const posterRatingSources = (() => {');
const end = page.indexOf('        // MDBList rating sources:', start);
const source = page.slice(start, end);

function setup(t) {
  const h = createHarness({ html: '<input id="ratingTagsSources" type="hidden"><div id="ratingTagsSourceRows"></div><select id="ratingTagsMinScore"><option value="0">Off</option><option value="8">8</option></select><input id="ratingTagsColorByScore" type="checkbox">' });
  t.after(() => h.close());
  h.window.eval(source + '\nwindow.editor = posterRatingSources;');
  return { ...h, editor: h.window.editor };
}

test('admin source controls load legacy switches, localize and collect explicit order and empty choices', t => {
  const h = setup(t);
  h.editor.load({ RatingTagsShowCommunity: false });
  assert.deepEqual(plain(h.editor.collect()), ['critic']);
  h.editor.translate({ rating_source_imdb: 'IMDb', rating_sources_up: 'Move {source} up', rating_sources_down: 'Move {source} down' });
  assert.equal(h.document.querySelector('[data-source="imdb"] span').textContent, 'IMDb');
  h.editor.load({ RatingTagsSources: ['imdb', 'unknown', 'tmdb', 'imdb'], RatingTagsMinScore: 8, RatingTagsColorByScore: true });
  assert.deepEqual(plain(h.editor.collect()), ['imdb', 'tmdb']);
  h.document.querySelector('[data-source="tmdb"] [data-step="-1"]').click();
  assert.deepEqual(plain(h.editor.collect()), ['tmdb', 'imdb']);
  assert.equal(h.document.getElementById('ratingTagsMinScore').value, '8');
  assert.equal(h.document.getElementById('ratingTagsColorByScore').checked, true);
  for (const el of h.document.querySelectorAll('#ratingTagsSourceRows input')) el.checked = false;
  assert.deepEqual(plain(h.editor.collect()), []);
  assert.match(page, /config\.RatingTagsSources = posterRatingSources\.collect\(\)/);
  assert.match(page, /ratingSources=' \+ JSON\.stringify\(posterRatingSources\.collect\(\)\)/);
});
