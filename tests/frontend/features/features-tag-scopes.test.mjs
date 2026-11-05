import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// "Where to show" (JE.core.tagScopes): every card group can be limited to item types and to the
// Continue Watching and Next Up rows; personal switches over the administrator's over "on".

function setup(t, { settings = {}, plugin = {}, html = '' } = {}) {
  const h = createHarness({ html, JE: { currentSettings: { ...settings }, pluginConfig: { ...plugin }, helpers: {}, core: {},
    session: { getUserId: () => 'a', getServerId: () => 's', onUserChange() {} },
    tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } } });
  t.after(() => h.close());
  h.load('core/tag-renderer-base.js');
  return { h, S: h.JE.core.tagScopes };
}

test('a switch resolves personal, then the administrator, then on, for every scoped group', t => {
  const { S } = setup(t, { settings: { tagGroupScopes: { genre: { episodes: true, series: false } } },
    plugin: { TagGroupScopes: { Genre: { Episodes: false }, AgeRating: { Movies: false } } } });
  assert.equal(S.allows('genre', 'episodes'), true, 'personal on beats the administrator off');
  assert.equal(S.allows('genre', 'series'), false, 'personal off');
  assert.equal(S.allows('genre', 'movies'), true, 'unset everywhere: on');
  assert.equal(S.allows('ageRating', 'movies'), false, 'the administrator off');
  assert.equal(S.allows('agerating', 'movies'), false, 'the age rating renderer name is the same group');
  assert.equal(S.allows('people', 'movies'), true, 'People Tags have no switches');
  for (const group of S.SCOPED_GROUPS) for (const scope of S.SCOPE_IDS) assert.equal(typeof S.allows(group, scope), 'boolean');
});

test('Rating uses its own six switches through the same rule', t => {
  const { S } = setup(t, { settings: { ratingTagsOnSeasons: false }, plugin: { RatingTagsOnNextUp: false } });
  assert.equal(S.allows('rating', 'seasons'), false);
  assert.equal(S.allows('rating', 'nextUp'), false, 'no personal value: the administrator');
  assert.equal(S.allows('rating', 'movies'), true);
});

test('setOwn and follow write only the personal document, and following clears the group', t => {
  const { h, S } = setup(t, { plugin: { TagGroupScopes: { Logos: { NextUp: false } }, RatingTagsOnEpisodes: false } });
  S.setOwn('logos', 'nextUp', true);
  S.setOwn('logos', 'movies', false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.JE.currentSettings.tagGroupScopes)), { logos: { nextUp: true, movies: false } });
  assert.equal(S.allows('logos', 'nextUp'), true);
  S.follow('logos');
  assert.equal(h.JE.currentSettings.tagGroupScopes, null);
  assert.equal(S.allows('logos', 'nextUp'), false, 'back to the administrator');
  S.setOwn('rating', 'episodes', true);
  assert.equal(h.JE.currentSettings.ratingTagsOnEpisodes, true);
  S.follow('rating');
  assert.equal(h.JE.currentSettings.ratingTagsOnEpisodes, false, 'Rating follows by taking the administrator values');
});

test('a group switched off for a card type is not drawn on that card, through the shared renderer commit', t => {
  const html = '<div class="card" data-type="Episode"><div class="je-tag-host" id="ep"></div></div><div class="card" data-type="Movie"><div class="je-tag-host" id="mv"></div></div>';
  const { h } = setup(t, { html, settings: { on: true, tagGroupScopes: { genre: { episodes: false } } } });
  const ctx = h.JE.core.tagRenderer.register('genre', { logPrefix: 'genre', settingKey: 'on', containerClass: 'genre-overlay-container', taggedAttr: 'jeGenreTagged' });
  const overlay = () => { const el = h.document.createElement('div'); el.className = 'genre-overlay-container'; el.append(h.document.createElement('span')); return el; };
  assert.equal(ctx.commitOverlay(h.document.getElementById('ep'), overlay()), false, 'episodes: off');
  assert.equal(h.document.querySelector('#ep .genre-overlay-container'), null);
  assert.equal(ctx.commitOverlay(h.document.getElementById('mv'), overlay()), true, 'movies: on');
  assert.ok(h.document.querySelector('#mv .genre-overlay-container'));
});

test('the home-row switches read the row a card sits in, and only when one is off', t => {
  const html = '<div class="card" data-type="Episode"><div class="je-tag-host" id="cw"></div></div>';
  const { h, S } = setup(t, { html, settings: { tagGroupScopes: { status: { continueWatching: false } } } });
  let asked = 0;
  h.JE.detectCardRowSurface = () => { asked++; return 'continuewatching'; };
  assert.equal(S.excludes('status', h.document.getElementById('cw')), true);
  assert.equal(S.excludes('genre', h.document.getElementById('cw')), false);
  assert.equal(asked, 1, 'a group whose row switches are all on never asks for the row');
});

test('the settings matrix offers the common controls on every surface, with a reason where it does not', t => {
  const { h } = setup(t);
  const M = h.JE.core.tagSettingsMatrix;
  for (const surface of ['admin', 'hub', 'itemEditor']) for (const group of M.groups) for (const control of M.controls) {
    const offered = M.offers(surface, group, control);
    assert.ok(offered === true || (typeof offered === 'string' && offered.length > 0), `${surface}/${group}/${control}`);
  }
  assert.equal(M.offers('admin', 'genre', 'scopes'), true);
  assert.equal(M.offers('admin', 'people', 'scopes'), 'tag_scope_people_na');
  assert.equal(M.offers('itemEditor', 'genre', 'scopes'), 'tag_item_editor_scope_note');
});
