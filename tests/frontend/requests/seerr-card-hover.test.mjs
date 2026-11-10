import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// BUG-019: Gecko delivers mouseenter only to a page that had a mouseenter listener before the pointer
// moved. The card row is bound during the first move's mouseover, so in Firefox no mouseenter follows:
// the overview must come from the mouseover/mouseout pair alone.
test('BUG-019: the hover overview follows mouseover and mouseout, with no mouseenter at all', t => {
  const h = createHarness({ JE: {
    t: key => key, escapeHtml: value => String(value),
    jellyseerrAPI: { resolveJellyseerrBaseUrl: () => 'http://seerr:5055' },
    cdn: { url: path => `/cdn/${path}`, selfhst: path => `/selfhst/${path}` }
  } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'jellyseerr/seerr-status.js', 'jellyseerr/ui/ui-icons.js', 'jellyseerr/ui/ui-badges.js', 'jellyseerr/ui/ui-cards.js']) h.load(file);
  const card = h.JE.jellyseerrUI.createJellyseerrCard({ id: 603, mediaType: 'movie', title: 'The Matrix', overview: 'Neo' }, true, true);
  const row = h.document.createElement('div');
  row.append(card);
  h.document.body.append(row);
  const outside = h.document.createElement('div');
  h.document.body.append(outside);
  const poster = card.querySelector('.cardScalable');
  const inner = poster.querySelector('.cardImageContainer') ?? poster.firstElementChild;
  const move = (type, target, relatedTarget) => target.dispatchEvent(new h.window.MouseEvent(type, { bubbles: true, relatedTarget }));
  move('mouseover', inner, outside);
  assert.ok(card.querySelector('.jellyseerr-overview'), 'entering the poster shows the overview');
  // Moving between the poster's own parts is not leaving it.
  move('mouseout', inner, poster);
  move('mouseover', poster, inner);
  assert.ok(card.querySelector('.jellyseerr-overview'));
  move('mouseout', poster, outside);
  assert.equal(card.querySelector('.jellyseerr-overview'), null);
});
