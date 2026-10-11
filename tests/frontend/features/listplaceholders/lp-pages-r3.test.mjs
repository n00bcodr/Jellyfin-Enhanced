// Review round 3: JE's real Seerr card builds its request button lazily (hover/tap overview), so the lock for an
// already-requested season must apply to that button, not only to one present when the card is built.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph, MODULES } from './lp-harness.mjs';

/** List placeholder modules over JE's real Seerr card, buttons and popover. */
function cardHarness(t) {
  const h = setup(t, { load: false, extraJE: {
    core: { ui: { addTouchTapListener: () => {} }, api: { plugin: async () => ({}) } },
    hiddenContent: { getSettings: () => ({ enabled: true }), isHiddenByTmdbId: () => false }
  } });
  h.JE.cdn.selfhst = path => `http://cdn.test/${path}`;
  h.JE.jellyseerrAPI.resolveJellyseerrBaseUrl = () => '';
  for (const file of ['seerr-status.js', 'ui/ui-icons.js', 'ui/ui-badges.js', 'ui/ui-popover.js', 'ui/ui-buttons.js', 'ui/ui-cards.js']) h.load(`jellyseerr/${file}`);
  for (const file of MODULES) h.load(`jellyseerr/listplaceholders/${file}`);
  t.after(() => h.JE.jellyseerrUI.releasePosters?.());
  return h;
}

/** Builds a placeholder card, hovers it and returns its (lazily built) request button. */
function hoveredButton(h, placeholder) {
  const card = h.lp.render.buildCard(placeholder, { seerrEnabled: true, canEdit: true, user: { active: true, userFound: true } });
  h.document.body.append(card);
  assert.equal(card.querySelector('.jellyseerr-request-button'), null, 'JE builds the button on hover');
  card.querySelector('.cardScalable').dispatchEvent(new h.window.MouseEvent('mouseenter'));
  return card.querySelector('.jellyseerr-request-button');
}

for (const [label, status] of [['processing', 3], ['pending', 2]]) {
  test(`a ${label} season placeholder's hover button is locked like its playlist row`, t => {
    const h = cardHarness(t);
    const button = hoveredButton(h, ph('s', { kind: 'season', mediaType: 'tv', tmdbId: 114502, seasonNumber: 2, status }));
    assert.ok(button);
    assert.equal(button.disabled, true);
    const config = h.JE.seerrStatus.getButtonConfig(h.JE.seerrStatus.resolveDisplayStatus(status, false));
    assert.ok(button.classList.contains(config.cssClass));
  });
}

test('a requestable season and a movie keep JE\'s own button', t => {
  const h = cardHarness(t);
  assert.equal(hoveredButton(h, ph('s', { kind: 'season', mediaType: 'tv', tmdbId: 114502, seasonNumber: 2, status: 1 })).disabled, false);
  assert.equal(hoveredButton(h, ph('m', { tmdbId: 7, status: 3 })).classList.contains('jellyseerr-button-request'), false);
});
