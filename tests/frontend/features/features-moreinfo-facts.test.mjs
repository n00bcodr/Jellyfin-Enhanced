// The More Info external-link row: when ratings carry no Rotten Tomatoes URL (no ratings for the title, or not read
// yet) the link searches Rotten Tomatoes for the title instead of being an empty link that reopens the page itself.
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
const rt = links => links.find(([k]) => k === 'rt');

for (const [label, data, mediaType, expected] of [
  ['a movie without ratings', { id: 693134, title: 'Dune: Part Two', imdbId: 'tt15239678' }, 'movie',
    'https://www.rottentomatoes.com/search?search=Dune%3A%20Part%20Two'],
  ['a movie whose ratings have no Rotten Tomatoes entry', { id: 693134, title: 'Dune: Part Two', ratings: { imdb: {} } }, 'movie',
    'https://www.rottentomatoes.com/search?search=Dune%3A%20Part%20Two'],
  ['a series without a ratings URL', { id: 83867, name: 'Andor & Co', ratings: {} }, 'tv',
    'https://www.rottentomatoes.com/search?search=Andor%20%26%20Co'],
  ['a title with no name at all', { id: 1 }, 'movie', 'https://www.rottentomatoes.com'],
]) test(`the Rotten Tomatoes link for ${label} is a search, never empty`, t => {
  const links = facts(t, data, mediaType);
  assert.deepEqual(rt(links), ['rt', expected]);
  assert.ok(links.every(([, href]) => href), 'no empty link');
});

for (const [mediaType, data, url] of [
  ['movie', { id: 693134, title: 'Dune: Part Two', ratings: { rt: { url: 'https://www.rottentomatoes.com/m/dune_part_two' } } },
    'https://www.rottentomatoes.com/m/dune_part_two'],
  ['tv', { id: 83867, name: 'Andor', ratings: { url: 'https://www.rottentomatoes.com/tv/andor' } }, 'https://www.rottentomatoes.com/tv/andor'],
]) test(`a ${mediaType} ratings URL is kept as the Rotten Tomatoes link`, t => {
  assert.deepEqual(rt(facts(t, data, mediaType)), ['rt', url]);
});
