// The MDBList "Configure ratings shown" list and its linked copy on the Services tab (upstream 782a8364): both lists
// carry the saved ticks and order, an edit in either one is what Save writes, and the card is a group like the others.
// Driven through the generated page, as the dashboard runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGenerated, settle } from '../../helpers/admin-config-page.mjs';

const MAIN = 'mdblistRatingsSourcesAdmin';
const COPY = 'mdblistRatingsSourcesAdmin--mirror';

async function boot(t, saved) {
  const h = bootGenerated({ saved });
  t.after(() => h.close());
  await h.ready();
  h.show();
  await settle(h.window);
  const list = id => h.document.getElementById(id);
  const rows = id => [...list(id).querySelectorAll('.je-quality-cat-admin-row')];
  /** The list as `key` or `key*` (ticked), in its order. */
  const read = id => rows(id).map(r => r.dataset.sourceKey + (r.querySelector('.je-mdblist-source-toggle').checked ? '*' : ''));
  const row = (id, key) => rows(id).find(r => r.dataset.sourceKey === key);
  const save = async () => {
    h.document.querySelector('#JellyfinEnhancedForm').dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle(h.window, 120);
    assert.equal(h.calls.puts.length, 1, 'one save');
    return h.calls.puts[0].MdblistRatingsSources;
  };
  return { h, list, read, row, save };
}

const SAVED = { MdblistRatingsEnabled: true, MdblistRatingsSources: 'imdb,tmdb' };
const EXPECTED = ['imdb*', 'tmdb*', 'tomatoes', 'popcorn', 'trakt', 'metacritic', 'metacriticuser', 'letterboxd', 'rogerebert', 'myanimelist', 'anilist', 'master'];

test('MDBList ratings list: the Services tab copy shows the saved ticks and order, like the card', async t => {
  const { list, read } = await boot(t, SAVED);
  assert.ok(list(COPY), 'the Services tab has its copy');
  assert.deepEqual(read(MAIN), EXPECTED);
  assert.deepEqual(read(COPY), EXPECTED);
});

test('MDBList ratings list: a tick changed on the Services tab reaches the card and Save', async t => {
  const { h, read, row, save } = await boot(t, SAVED);
  const box = row(COPY, 'imdb').querySelector('.je-mdblist-source-toggle');
  box.checked = false;
  box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle(h.window);
  assert.deepEqual(read(MAIN).slice(0, 2), ['imdb', 'tmdb*']);
  assert.equal(await save(), 'tmdb');
});

test('MDBList ratings list: an arrow on the Services tab reorders both lists, and Save keeps that order', async t => {
  const { h, read, row, save } = await boot(t, SAVED);
  row(COPY, 'tmdb').querySelector('.je-cat-up').click();
  await settle(h.window);
  assert.deepEqual(read(COPY).slice(0, 2), ['tmdb*', 'imdb*']);
  assert.deepEqual(read(MAIN), read(COPY), 'the card follows');
  assert.equal(row(COPY, 'tmdb').querySelector('.je-cat-up').disabled, true, 'the copy\'s arrows are refreshed at the ends');
  assert.equal(await save(), 'tmdb,imdb');
});

test('MDBList ratings list: an edit on the card reaches the Services tab copy', async t => {
  const { h, read, row } = await boot(t, SAVED);
  row(MAIN, 'imdb').querySelector('.je-cat-down').click();
  const box = row(MAIN, 'trakt').querySelector('.je-mdblist-source-toggle');
  box.checked = true;
  box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await settle(h.window);
  assert.deepEqual(read(MAIN).slice(0, 5), ['tmdb*', 'imdb*', 'tomatoes', 'popcorn', 'trakt*']);
  assert.deepEqual(read(COPY), read(MAIN));
});

test('MDBList ratings list: "Configure ratings shown" is a group like its neighbours, on the card and its copy', async t => {
  const { list } = await boot(t, SAVED);
  for (const id of [MAIN, COPY]) {
    const group = list(id).closest('details');
    assert.ok(group.classList.contains('jea-group'), id);
    assert.equal(group.querySelector(':scope > summary').textContent, 'Configure ratings shown');
    assert.equal(list(id).closest('.je-details-section'), null, id);
  }
});
