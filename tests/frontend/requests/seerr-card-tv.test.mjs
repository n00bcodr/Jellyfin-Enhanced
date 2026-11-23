import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

function setup(t, { tv, modal }) {
  const h = createHarness({ JE: {
    t: key => key, escapeHtml: value => String(value),
    pluginConfig: { JellyseerrUseMoreInfoModal: modal },
    jellyseerrAPI: { resolveJellyseerrBaseUrl: () => 'http://seerr:5055' },
    jellyseerrMoreInfo: { open() {} },
    cdn: { url: path => `/cdn/${path}`, selfhst: path => `/selfhst/${path}` }
  } });
  t.after(() => h.close());
  if (tv) h.document.documentElement.classList.add('layout-tv');
  for (const file of ['core/ui-kit.js', 'jellyseerr/seerr-status.js', 'jellyseerr/ui/ui-icons.js', 'jellyseerr/ui/ui-badges.js', 'jellyseerr/ui/ui-cards.js']) h.load(file);
  const card = h.JE.jellyseerrUI.createJellyseerrCard({ id: 603, mediaType: 'movie', title: 'The Matrix', overview: 'Neo' }, true, true);
  h.document.body.appendChild(card);
  return { h, card };
}

test('the poster is reachable by remote navigation', t => {
  const { card } = setup(t, { tv: false, modal: false });
  assert.ok(card.querySelector('.jellyseerr-poster-image').classList.contains('focusable'));
});

test('TV layout never links the title out to Seerr', t => {
  const { card } = setup(t, { tv: true, modal: false });
  const link = card.querySelector('.jellyseerr-more-info-link');
  assert.equal(link.getAttribute('href'), '#');
  assert.equal(link.getAttribute('target'), null);
});

test('other layouts keep the external Seerr link when the modal is off', t => {
  const { card } = setup(t, { tv: false, modal: false });
  const link = card.querySelector('.jellyseerr-more-info-link');
  assert.equal(link.getAttribute('href'), 'http://seerr:5055/movie/603');
  assert.equal(link.getAttribute('target'), '_blank');
});

// Hidden Content treats the name as text everywhere (confirmation, undo toast, the Hidden Content page,
// the calendar's title match) and stores it as given, so the card must pass the title, not HTML.
test('hiding from a card passes the plain title', t => {
  const hides = [];
  const h = createHarness({ JE: {
    t: key => key,
    pluginConfig: {},
    jellyseerrAPI: { resolveJellyseerrBaseUrl: () => 'http://seerr:5055' },
    jellyseerrMoreInfo: { open() {} },
    cdn: { url: path => `/cdn/${path}`, selfhst: path => `/selfhst/${path}` },
    hiddenContent: { getSettings: () => ({ enabled: true, showHideButtons: true, showButtonJellyseerr: true }), isHiddenByTmdbId: () => false,
      confirmAndHide: item => hides.push(item) }
  } });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'jellyseerr/seerr-status.js', 'jellyseerr/ui/ui-icons.js', 'jellyseerr/ui/ui-badges.js', 'jellyseerr/ui/ui-cards.js']) h.load(file);
  const card = h.JE.jellyseerrUI.createJellyseerrCard({ id: 1, mediaType: 'tv', name: 'Tom & Jerry\'s <Show> "Live"', overview: '' }, true, true);
  h.document.body.appendChild(card);
  card.querySelector('.je-hide-btn').click();
  assert.equal(hides.length, 1);
  assert.equal(hides[0].name, 'Tom & Jerry\'s <Show> "Live"');
  assert.equal(hides[0].tmdbId, 1);
});
