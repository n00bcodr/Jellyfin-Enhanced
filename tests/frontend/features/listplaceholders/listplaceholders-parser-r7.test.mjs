import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// Review round 7 (parser, → chains): a link in dropped commentary whose label repeats the kept title names nothing,
// and a bare URL inside commentary after an episode reference names nothing either.

function setup(t) {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  h.load('jellyseerr/listplaceholders/listplaceholders-parser.js');
  return { parse: (text, options) => plain(h.JE.listPlaceholders.parser.parse(text, options)) };
}

const eps = entry => entry.episodes?.map(x => `${x.s}x${x.e}`);

test('R7: a commentary link labelled like the kept title does not give the entry its id', t => {
  const { parse } = setup(t);
  const flash = parse('The Flash 1x08 — not the [The Flash](https://www.themoviedb.org/movie/298618) movie → Arrow 3x08').entries;
  assert.equal(flash[0].title, 'The Flash');
  assert.deepEqual(eps(flash[0]), ['1x8']);
  assert.equal(flash[0].ids, undefined);
  const batman = parse('Batman (1989). Not [Batman](https://www.themoviedb.org/movie/2661) from 1966 → Batman Returns').entries;
  assert.equal(batman[0].title, 'Batman');
  assert.equal(batman[0].ids, undefined);
  const supergirl = parse('Supergirl 2x08 (not the [Supergirl](https://www.themoviedb.org/movie/9651) film) → Arrow 3x08').entries;
  assert.equal(supergirl[0].title, 'Supergirl');
  assert.deepEqual(eps(supergirl[0]), ['2x8']);
  assert.equal(supergirl[0].ids, undefined);
  // A link on the kept title itself still names it, even when the same words come again in the commentary.
  const linked = parse('[The Flash](https://www.themoviedb.org/tv/60735) 1x08 — not The Flash movie → Arrow 3x08').entries;
  assert.deepEqual(linked[0].ids, { tmdb: 60735, tmdbType: 'tv' });
});

test('R7: a bare URL in commentary after an episode reference names nothing; one right after the reference does', t => {
  const { parse } = setup(t);
  const arrow = parse('Flash 1x08 → Arrow 3x08 (see https://www.themoviedb.org/tv/60735 for Flash)').entries;
  assert.equal(arrow[1].title, 'Arrow');
  assert.equal(arrow[1].ids, undefined);
  const flash = parse('The Flash 1x08 (see also <https://www.themoviedb.org/tv/62643>) → Arrow 3x08').entries;
  assert.equal(flash[0].title, 'The Flash');
  assert.equal(flash[0].ids, undefined);
  const dashed = parse('The Flash 1x08 — see https://www.themoviedb.org/tv/62643 → Arrow 3x08').entries;
  assert.equal(dashed[0].ids, undefined);
  // Right after the reference, before any commentary, the URL still names the title; bare ids anywhere still do.
  const direct = parse('Flash 1x08 https://www.themoviedb.org/tv/60735 → Arrow 3x08').entries;
  assert.deepEqual(direct[0].ids, { tmdb: 60735, tmdbType: 'tv' });
  const token = parse('Flash S1E8 (aka tmdb:tv:60735) → Arrow 3x08').entries;
  assert.deepEqual(token[0].ids, { tmdb: 60735, tmdbType: 'tv' });
});
