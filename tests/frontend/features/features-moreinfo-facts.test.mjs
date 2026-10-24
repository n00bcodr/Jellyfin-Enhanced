// The external-link row the More Info window and a native page's information panel share (A1 live finding): without
// Seerr's ratings (Jellyfin Enhanced mode reads TMDB) the Rotten Tomatoes link looks the title up instead of being an
// empty link that opens the page itself again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

function facts(t, data, mediaType) {
  const h = createHarness({ JE: {
    escapeHtml: s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
    seerrStatus: { MEDIA: { AVAILABLE: 5 } },
    internals: { moreInfoModal: { state: {} } },
    jellyseerrAPI: { resolveJellyseerrBaseUrl: () => '' },
  } });
  t.after(() => h.close());
  h.load('jellyseerr/moreinfo/more-info-modal-badges.js');
  const box = h.document.createElement('div');
  box.innerHTML = h.JE.internals.moreInfoModal.buildMediaFacts(data, mediaType, data.id);
  return [...box.querySelectorAll('a')].map(a => [a.className.split(' ')[1], a.getAttribute('href')]);
}

test('without Seerr\'s ratings the Rotten Tomatoes link searches for the title; with them it is Seerr\'s own', t => {
  const movie = facts(t, { id: 693134, title: 'Dune: Part Two', imdbId: 'tt15239678' }, 'movie');
  assert.deepEqual(movie.find(([k]) => k === 'rt'), ['rt', 'https://www.rottentomatoes.com/search?search=Dune%3A%20Part%20Two']);
  assert.ok(movie.every(([, href]) => href), 'no empty link');
  assert.equal(movie.some(([k]) => k === 'jellyseerr'), false, 'no Seerr link without a Seerr address');
  const series = facts(t, { id: 83867, name: 'Andor', ratings: { url: 'https://www.rottentomatoes.com/tv/andor' } }, 'tv');
  assert.deepEqual(series.find(([k]) => k === 'rt'), ['rt', 'https://www.rottentomatoes.com/tv/andor']);
});
