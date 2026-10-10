import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph } from './lp-harness.mjs';

test('rows escape every placeholder string and never look like jellyfin-web rows', t => {
  const h = setup(t);
  const evil = ph('p1', { title: '<img src=x onerror=alert(1)>', note: '"><script>bad()</script>', posterPath: '/x.jpg" onerror="alert(1)', kind: 'custom', tmdbId: null });
  const rows = h.lp.render.buildRows([evil], { canEdit: true, draggable: true, seerrEnabled: true, user: { active: true, userFound: true } });
  const row = rows.get('p1');
  assert.ok(row);
  assert.equal(row.querySelector('img[src="x"]'), null);
  assert.equal(row.querySelector('script'), null);
  assert.equal(row.querySelector('.je-lp-title').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(row.querySelector('.je-lp-note').textContent, '"><script>bad()</script>');
  // unsafe poster path falls back to JE's "poster not found" image
  assert.match(row.querySelector('.je-lp-thumb img').getAttribute('src'), /^http:\/\/cdn\.test\/ibb\//);
  assert.ok(!row.classList.contains('listItem'));
  assert.equal(row.hasAttribute('data-id'), false);
  assert.equal(row.querySelector('.itemAction, [data-action]'), null);
  // custom entries have no request button or badge
  assert.equal(row.querySelector('.je-lp-request'), null);
  assert.ok(row.querySelector('.listViewDragHandle'));
  assert.ok(row.querySelector('.je-lp-menu-btn'));
});

test('subtitles describe kind, episodes and release state', t => {
  const h = setup(t);
  const r = h.lp.render;
  const parts = value => [...r.subtitleParts(value)];
  assert.deepEqual(parts(ph('a')), ['listPlaceholders_kind_movie', '2013']);
  assert.deepEqual(parts(ph('b', { releaseDate: null, released: false, year: null })), ['listPlaceholders_kind_movie', 'listPlaceholders_tba']);
  const coming = r.subtitleParts(ph('c', { releaseDate: '2026-10-23', released: false }));
  assert.equal(coming[1].startsWith('listPlaceholders_coming{"date":"'), true);
  assert.match(coming[1], /2026/);
  assert.deepEqual(parts(ph('d', { kind: 'season', mediaType: 'tv', seasonNumber: 1, episodeTotal: 10, filledCount: 3 })),
    ['jellyseerr_season_name{"number":1}', 'listPlaceholders_episodes_of{"filled":3,"total":10}', '2013']);
  assert.equal(r.kindLabel(ph('e', { kind: 'season', mediaType: 'tv', seasonNumber: 0 })), 'jellyseerr_season_specials');
  const ep = (list) => r.episodeLabel({ seasonNumber: 1, episodes: list.map(e => ({ s: 1, e })) });
  assert.equal(ep([8]), 'S01E08');
  assert.equal(ep([10, 8, 9]), 'S01E08–E10');
  assert.equal(ep([8, 10]), 'S01E08, E10');
  assert.equal(ep([1, 3, 5, 7]), 'S01 · listPlaceholders_episode_count{"count":4}');
  assert.deepEqual(parts(ph('f', { kind: 'episodes', mediaType: 'tv', seasonNumber: 1, episodes: [{ s: 1, e: 8, title: 'Flash vs. Arrow' }] })),
    ['S01E08', 'Flash vs. Arrow', '2013']);
  assert.deepEqual(parts(ph('g', { kind: 'custom', tmdbId: null, releaseDate: null, released: false, year: 2027 })), ['listPlaceholders_kind_custom', '2027']);
});

test('status badges follow Seerr status configs and request buttons follow the user status', t => {
  const h = setup(t);
  const r = h.lp.render;
  const ctx = { seerrEnabled: true, statusReady: true, user: { active: true, userFound: true } };
  let html = r.statusHtml(ph('a', { status: 1 }), ctx);
  assert.match(html, /je-lp-request/);
  assert.doesNotMatch(html, /je-lp-badge/);
  html = r.statusHtml(ph('a', { status: 5 }), ctx);
  assert.match(html, /status-available/);
  assert.doesNotMatch(html, /je-lp-request/);
  html = r.statusHtml(ph('a', { status: 7 }), ctx);
  assert.match(html, /status-deleted/);
  assert.match(html, /je-lp-request/);
  html = r.statusHtml(ph('a', { status: null }), { ...ctx, statusReady: false });
  assert.match(html, /je-lp-badge-loading/);
  assert.match(r.statusHtml(ph('a'), { ...ctx, user: { active: false, userFound: false } }), /jellyseerr_btn_offline/);
  assert.match(r.statusHtml(ph('a'), { ...ctx, user: { active: true, userFound: false } }), /jellyseerr_btn_user_not_found/);
  assert.equal(r.statusHtml(ph('a'), { ...ctx, seerrEnabled: false }), '');
  assert.equal(r.statusHtml(ph('a', { kind: 'custom', tmdbId: null }), ctx), '');
});

test('synthetic Seerr items coerce the TMDB id, whitelist the media type and flag __jeLp', t => {
  const h = setup(t);
  const r = h.lp.render;
  const item = r.toSeerrItem(ph('a', { tmdbId: '42', posterPath: '/ok.jpg', status: 2 }));
  assert.equal(item.id, 42);
  assert.equal(item.mediaType, 'movie');
  assert.equal(item.__jeLp, true);
  assert.equal(item.releaseDate, '2013-08-09');
  assert.deepEqual({ ...item.mediaInfo }, { status: 2, status4k: 1 });
  const tv = r.toSeerrItem(ph('b', { mediaType: 'tv', kind: 'season', seasonNumber: 1, posterPath: '/bad path.jpg', status: null }));
  assert.equal(tv.firstAirDate, '2013-08-09');
  assert.equal(tv.posterPath, null);
  assert.equal(tv.mediaInfo, null);
  assert.equal(r.toSeerrItem(ph('c', { mediaType: 'collection' })), null);
  assert.equal(r.toSeerrItem(ph('d', { tmdbId: 'abc' })), null);
  assert.equal(r.toSeerrItem(ph('e', { kind: 'custom' })), null);
});

test('collection cards use JE Seerr cards for TMDB placeholders and an own card for custom entries', t => {
  const created = [];
  const h = setup(t, { jellyseerrUI: { createJellyseerrCard: (item, active, found) => {
    created.push({ item, active, found });
    const card = document.createElement('div');
    card.className = 'card overflowPortraitCard jellyseerr-card';
    card.innerHTML = '<div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div><div class="jellyseerr-meta"><bdi>N/A</bdi><div class="jellyseerr-rating">N/A</div></div></div>';
    return card;
  } } });
  const document = h.document;
  const ctx = { canEdit: true, seerrEnabled: true, user: { active: true, userFound: false } };
  const card = h.lp.render.buildCard(ph('a', { kind: 'season', mediaType: 'tv', seasonNumber: 2, releaseDate: null, released: false }), ctx);
  assert.equal(created.length, 1);
  assert.equal(created[0].item.__jeLp, true);
  assert.equal(created[0].active, true);
  assert.equal(created[0].found, false);
  assert.ok(card.classList.contains('portraitCard'));
  assert.ok(!card.classList.contains('overflowPortraitCard'));
  assert.equal(card.getAttribute('data-je-lp-id'), 'a');
  assert.equal(card.querySelector('.je-lp-kind-chip').textContent, 'jellyseerr_season_name{"number":2}');
  assert.equal(card.querySelector('.jellyseerr-meta bdi').textContent, 'listPlaceholders_tba');
  assert.equal(card.querySelector('.jellyseerr-rating'), null);
  assert.ok(card.querySelector('.jellyseerr-meta .je-lp-menu-btn'));
  const custom = h.lp.render.buildCard(ph('b', { kind: 'custom', tmdbId: null, title: '<b>x</b>' }), { ...ctx, canEdit: false });
  assert.equal(created.length, 1);
  assert.ok(custom.classList.contains('je-lp-card-custom'));
  assert.equal(custom.querySelector('b'), null);
  assert.equal(custom.querySelector('.cardText-first').textContent, '<b>x</b>');
  assert.equal(custom.querySelector('.je-lp-menu-btn'), null);
  void document;
});
