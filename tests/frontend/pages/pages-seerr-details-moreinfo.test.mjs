import test from 'node:test';
import assert from 'node:assert/strict';
import { plain } from '../helpers/harness.mjs';
import { deferred, moreInfoHarness, movie, show, strictEscape } from '../helpers/seerr-details.mjs';

// The real eight more-info scripts over stubbed Seerr facades: what reaches the page,
// which account and title a write belongs to, and what is left when the modal goes.
const ATTACK = '"><i data-pwned="1"></i><img src=x onerror=alert(1) x="';
const available = { status: 5, jellyfinMediaId: 'lib-1' };

test('every field of a reply reaches the page as text, in movies and in shows', async t => {
  const hostile = {
    id: 7, title: ATTACK, name: ATTACK, tagline: ATTACK, overview: ATTACK, status: ATTACK, posterPath: `/${ATTACK}`, backdropPath: `/${ATTACK}`,
    jeYear: ATTACK, originalLanguage: ATTACK, episodeRunTime: [ATTACK], runtime: ATTACK, budget: ATTACK, revenue: ATTACK,
    collection: { id: ATTACK, name: ATTACK, backdropPath: `/${ATTACK}` }, genres: [{ name: ATTACK }], keywords: [{ name: ATTACK }], createdBy: [{ name: ATTACK }],
    productionCountries: [{ name: ATTACK, iso_3166_1: ATTACK }], productionCompanies: [{ name: ATTACK }],
    watchProviders: [{ iso_3166_1: 'US', flatrate: [{ id: 1, name: ATTACK, logoPath: `/${ATTACK}` }] }],
    credits: { cast: [{ name: ATTACK, character: ATTACK, profilePath: `/${ATTACK}` }], crew: [{ job: 'Director', name: ATTACK }] },
    relatedVideos: [{ type: 'Trailer', site: 'YouTube', key: ATTACK, name: ATTACK, url: 'https://youtu.be/ok' }],
    seasons: [{ seasonNumber: 1, name: ATTACK, episodeCount: 1, overview: ATTACK, jeYear: ATTACK, posterPath: `/${ATTACK}` }]
  };
  const h = moreInfoHarness(t, { config: { ColoredRatingsEnabled: true } });
  for (const type of ['movie', 'tv']) {
    const host = h.document.createElement('div');
    host.innerHTML = h.internal.buildModalContent(hostile, type);
    assert.equal(host.querySelector('[data-pwned], [onerror]'), null, type);
    assert.match(host.querySelector('h1.title').textContent, /data-pwned/);
  }
  const logos = h.document.createElement('div');
  logos.innerHTML = h.internal.buildRatingLogos({ rt: { criticsScore: ATTACK, url: ATTACK }, imdb: { criticsScore: ATTACK } }, { voteAverage: 5, voteCount: 1 }, 'movie', ATTACK);
  assert.equal(logos.querySelector('[data-pwned], [onerror]'), null);
});

test('a link from a reply opens only over the web', t => {
  const h = moreInfoHarness(t);
  const host = h.document.createElement('div');
  host.innerHTML = h.internal.buildTrailersSection({ relatedVideos: [
    { type: 'Trailer', site: 'YouTube', key: 'a', name: 'Bad', url: 'javascript:alert(1)' }, { type: 'Trailer', site: 'YouTube', key: 'b', name: 'Good', url: 'https://youtu.be/b' }
  ] });
  assert.deepEqual([...host.querySelectorAll('a.trailer-item')].map(link => link.getAttribute('href')), ['https://youtu.be/b']);
  host.innerHTML = h.internal.buildRatingLogos({ rt: { criticsScore: 80, url: 'javascript:alert(1)' }, imdb: { criticsScore: 8, url: 'data:text/html,x' } }, {}, 'movie', 1);
  assert.deepEqual([...host.querySelectorAll('a')].map(link => link.getAttribute('href')), ['https://www.rottentomatoes.com', 'https://www.imdb.com']);
});

for (const type of ['movie', 'tv']) test(`Rotten Tomatoes links to the ${type}'s own page once ratings arrive, and is absent until then`, async t => {
  const url = 'https://www.rottentomatoes.com/x';
  const ratings = deferred();
  // The TV endpoint answers with the RT record itself, the movie one with {rt, imdb}.
  const h = moreInfoHarness(t, { details: async id => (type === 'tv' ? show(id) : movie(id)), ratings: () => ratings.promise });
  await h.P.open(1, type);
  assert.equal(h.modal.querySelector('.je-more-info-fact.rt'), null);
  assert.equal(h.modal.querySelector('.je-more-info-media-facts a[href=""]'), null);
  ratings.resolve(type === 'tv' ? { criticsScore: 90, url } : { rt: { criticsScore: 90, url } });
  await h.settle();
  assert.equal(h.modal.querySelector('.je-more-info-fact.rt').getAttribute('href'), url);
  assert.equal(h.modal.querySelector('.je-more-info-rt').closest('a').getAttribute('href'), url);
});

test('a request answered after the modal moved on cannot draw the old title into the new one', async t => {
  const pending = deferred();
  const h = moreInfoHarness(t, { api: { requestMedia: () => pending.promise } });
  await h.P.open(1, 'movie');
  h.modal.querySelector('.jellyseerr-request-button').click();
  await h.P.open(2, 'movie');
  const replacement = h.modal;
  const before = replacement.querySelector('[data-mount="je-actions"]').innerHTML;
  const announced = [];
  h.document.addEventListener('jellyseerr-media-requested', event => announced.push(event.detail.tmdbId));
  pending.resolve({ media: { status: 2 } });
  await h.settle();
  assert.equal(h.modal, replacement);
  assert.equal(replacement.dataset.tmdbId, '2');
  assert.equal(replacement.querySelector('[data-mount="je-actions"]').innerHTML, before);
  assert.equal(replacement.querySelector('[data-mount="je-status-chip"]').textContent, '');
  // The request did happen: other surfaces still hear of it.
  assert.deepEqual(announced, [1]);
});

test('a request answered after an account change neither redraws nor announces', async t => {
  const pending = deferred();
  const h = moreInfoHarness(t, { api: { requestMedia: () => pending.promise } });
  await h.P.open(1, 'movie');
  h.modal.querySelector('.jellyseerr-request-button').click();
  const old = h.modal;
  const announced = [];
  h.document.addEventListener('jellyseerr-media-requested', () => announced.push(true));
  h.switchUser();
  pending.resolve({ media: { status: 2 } });
  await h.settle();
  assert.deepEqual(announced, []);
  assert.equal(old.querySelector('[data-mount="je-status-chip"]').textContent, '');
});

test('a failed request reports only on a control still on screen; a quota dialog waits for the same account', async t => {
  const pending = [deferred(), deferred()];
  let call = 0;
  const h = moreInfoHarness(t, { api: { requestMedia: () => pending[call++].promise }, ui: { isQuotaError: error => error.quota === true } });
  await h.P.open(1, 'movie');
  const first = h.modal.querySelector('.jellyseerr-request-button');
  first.click();
  assert.equal(first.disabled, true);
  await h.P.open(2, 'movie');
  pending[0].reject(Object.assign(new Error('x'), { responseJSON: { message: '<b>nope</b>' } }));
  await h.settle();
  assert.equal(first.disabled, true, 'a control that left is not touched');
  const second = h.modal.querySelector('.jellyseerr-request-button');
  second.click();
  h.switchUser();
  pending[1].reject({ quota: true });
  await h.settle();
  assert.deepEqual(h.quotaDialogs, []);
});

test('a failure on the open modal restores the control and shows the reason as text', async t => {
  const h = moreInfoHarness(t, { api: { requestMedia: async () => { throw Object.assign(new Error('x'), { responseJSON: { message: '<b>nope</b>' } }); } } });
  await h.P.open(1, 'movie');
  const button = h.modal.querySelector('.jellyseerr-request-button');
  button.click();
  await h.settle();
  assert.equal(button.disabled, false);
  assert.equal(button.querySelector('b'), null);
  assert.match(button.textContent, /<b>nope<\/b>/);
  assert.ok(button.classList.contains('jellyseerr-button-error'));
});

test('request and failure icons come from the core icon library, in movies and shows', async t => {
  const failing = async () => { throw Object.assign(new Error('x'), { responseJSON: { message: 'nope' } }); };
  const h = moreInfoHarness(t, { api: { requestMedia: failing }, details: async (id, type) => (type === 'tv' ? show(id) : movie(id)) });
  // The real library, over the fixture's stand-in.
  delete h.JE.jellyseerrUI.icons;
  h.load('jellyseerr/ui/ui-icons.js');
  // By the icon's geometry: serialising turns its self-closed path into an open and close tag.
  const shapeOf = root => root.querySelector('svg path').getAttribute('d');
  const parsed = html => {
    const host = h.document.createElement('div');
    host.innerHTML = html;
    return shapeOf(host);
  };
  const { request, error } = h.JE.jellyseerrUI.icons;
  assert.notEqual(parsed(request), parsed(error));
  await h.P.open(1, 'movie');
  const button = h.modal.querySelector('.jellyseerr-request-button');
  assert.equal(shapeOf(button), parsed(request));
  assert.equal(button.querySelector('.material-icons'), null);
  button.click();
  await h.settle();
  assert.equal(button.textContent, 'nope');
  assert.equal(shapeOf(button), parsed(error));
  await h.P.open(2, 'tv');
  assert.equal(shapeOf(h.modal.querySelector('.jellyseerr-request-button')), parsed(request));
});

test('before the icon library has loaded, a request button still has its icon', async t => {
  const h = moreInfoHarness(t);
  delete h.JE.jellyseerrUI.icons;
  await h.P.open(1, 'movie');
  assert.equal(h.modal.querySelector('.jellyseerr-request-button .material-icons').textContent, 'download');
});

test('a quota rejection opens the dialog and returns the control to idle', async t => {
  const h = moreInfoHarness(t, { api: { requestMedia: async () => { throw { quota: true }; } }, ui: { isQuotaError: error => error.quota === true } });
  await h.P.open(1, 'movie');
  const button = h.modal.querySelector('.jellyseerr-request-button');
  button.click();
  await h.settle();
  assert.equal(h.quotaDialogs.length, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'jellyseerr_btn_request');
});

for (const change of ['closed', 'replaced', 'redrawn', 'account']) test(`the 4K menu goes when the modal is ${change}, and takes its listener with it`, async t => {
  const h = moreInfoHarness(t, { config: { JellyseerrEnable4KRequests: true } });
  await h.P.open(1, 'movie');
  const removed = [];
  const remove = h.document.removeEventListener.bind(h.document);
  h.document.removeEventListener = (type, ...rest) => { removed.push(type); remove(type, ...rest); };
  h.modal.querySelector('.jellyseerr-split-arrow').click();
  const option = h.popup().querySelector('button');
  if (change === 'closed') h.P.close();
  if (change === 'replaced') await h.P.open(2, 'movie');
  if (change === 'redrawn') h.internal.renderActions({ id: 1, title: 'x' }, 'movie', h.modal);
  if (change === 'account') h.switchUser();
  assert.equal(h.popup(), null);
  assert.ok(removed.includes('click'));
  option.click();
  await h.settle();
  assert.deepEqual(h.requests, []);
});

for (const [kind, details] of [
  ['request', id => show(id)],
  ['Request More', id => show(id, { mediaInfo: { status: 4, jellyfinMediaId: 'lib' } })]
]) test(`the TV ${kind} 4K menu goes with its modal, and cannot open a picker afterwards`, async t => {
  const h = moreInfoHarness(t, { details: async id => details(id), config: { JellyseerrEnable4KTvRequests: true } });
  h.internal.checkForUnrequestedSeasons = async () => true;
  await h.P.open(1, 'tv');
  await h.settle();
  h.modal.querySelector('.jellyseerr-split-arrow').click();
  const option = h.popup().querySelector('button');
  assert.equal(option.textContent, 'jellyseerr_btn_request_4k');
  h.switchUser();
  assert.equal(h.popup(), null);
  option.click();
  assert.equal(h.seasonPicks.length, 0);
});

test('the 4K menu offers the title only while it can be requested, and closes on an outside click', async t => {
  const h = moreInfoHarness(t, { config: { JellyseerrEnable4KRequests: true }, details: async id => movie(id, { mediaInfo: { status: 1, status4k: 3 } }) });
  await h.P.open(1, 'movie');
  h.modal.querySelector('.jellyseerr-split-arrow').click();
  const option = h.popup().querySelector('button');
  assert.equal(option.disabled, true);
  assert.ok(option.classList.contains('je-4k-pending'));
  h.document.body.click();
  assert.equal(h.popup(), null);
});

test('4K requests go through override rules like the normal ones: an empty settings object and the 4K flag', async t => {
  const h = moreInfoHarness(t, { config: { JellyseerrEnable4KRequests: true } });
  await h.P.open(1, 'movie');
  h.modal.querySelector('.jellyseerr-split-arrow').click();
  h.popup().querySelector('button').click();
  await h.settle();
  assert.deepEqual(plain(h.requests[0].slice(0, 4)), [1, 'movie', {}, true]);
  assert.equal(h.requests[0][4].id, 1);
  assert.equal(h.popup(), null);
  assert.equal(h.modal.querySelector('.je-status-chip').textContent, '4K jellyseerr_btn_requested');

  const single = moreInfoHarness(t, { config: { JellyseerrEnable4KRequests: true }, details: async id => movie(id, { mediaInfo: available }) });
  await single.P.open(1, 'movie');
  single.modal.querySelector('.jellyseerr-request-button').click();
  await single.settle();
  assert.deepEqual(plain(single.requests[0].slice(0, 4)), [1, 'movie', {}, true]);
});

test('with advanced options on, each request control opens the dialog instead of writing', async t => {
  const h = moreInfoHarness(t, { config: { JellyseerrEnable4KRequests: true }, api: { shouldShowAdvanced: () => true } });
  await h.P.open(1, 'movie');
  h.modal.querySelector('.jellyseerr-request-button').click();
  h.modal.querySelector('.jellyseerr-split-arrow').click();
  h.popup().querySelector('button').click();
  assert.deepEqual(h.movieDialogs.map(args => [args[0], args[1], args[3]]), [[1, 'Movie 1', false], [1, 'Movie 1', true]]);
  assert.deepEqual(h.requests, []);
  assert.equal(h.popup(), null);
});

test('during the exit animation nothing in the modal can start a write', async t => {
  const h = moreInfoHarness(t, { details: async id => movie(id, { collection: { id: 9, name: 'Set' } }) });
  await h.P.open(1, 'movie');
  const modal = h.modal;
  const request = modal.querySelector('.jellyseerr-request-button');
  const collection = modal.querySelector('.je-collection-card-button');
  const refresh = modal.querySelector('.modal-refresh');
  h.P.close();
  assert.equal(modal._isClosing, true);
  assert.ok(modal.isConnected, 'still animating out');
  request.click();
  collection.click();
  refresh.click();
  await h.settle();
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.collections, []);
  assert.equal(refresh.disabled, false);
  // An attached modal that is also closed in its first frame never turns active again.
  const quick = moreInfoHarness(t);
  await quick.P.open(1, 'movie');
  const first = quick.modal;
  quick.P.close();
  quick.clock.run(10);
  assert.equal(first.classList.contains('active'), false);
});

test('TV requests always go through the season picker, with the title of the show', async t => {
  const h = moreInfoHarness(t, { details: async id => show(id), config: { JellyseerrEnable4KTvRequests: true } });
  await h.P.open(5, 'tv');
  h.modal.querySelector('.jellyseerr-split-main').click();
  h.modal.querySelector('.jellyseerr-split-arrow').click();
  h.popup().querySelector('button').click();
  assert.deepEqual(h.seasonPicks.map(args => [args[0], args[1], args[2], args[4]]), [[5, 'tv', 'Show 5', false], [5, 'tv', 'Show 5', true]]);
  assert.equal(h.seasonPicks[0][3].id, 5);
  assert.deepEqual(h.requests, []);
});

test('Request More appears only for a show with seasons left, and not after the modal moved on', async t => {
  const release = deferred();
  const check = [];
  const details = async id => show(id, { mediaInfo: { status: 4, jellyfinMediaId: 'lib' } });
  const h = moreInfoHarness(t, { details });
  h.internal.checkForUnrequestedSeasons = (_data, signal) => { check.push(signal); return release.promise; };
  await h.P.open(1, 'tv');
  const old = h.modal.querySelector('[data-mount="je-actions"]');
  h.P.close();
  assert.equal(check[0].aborted, true, 'the lookups are cancelled, not only their result');
  release.resolve(true);
  await h.settle();
  assert.equal(old.children.length, 0);

  const open = moreInfoHarness(t, { details });
  open.internal.checkForUnrequestedSeasons = async () => true;
  await open.P.open(1, 'tv');
  await open.settle();
  assert.equal(open.modal.querySelector('.jellyseerr-request-button').textContent, 'jellyseerr_btn_request_more');
  open.modal.querySelector('.jellyseerr-request-button').click();
  assert.equal(open.seasonPicks.length, 1);
});

test('a redraw cancels the unrequested-seasons check of the render before it', async t => {
  const signals = [];
  const h = moreInfoHarness(t, { details: async id => show(id, { mediaInfo: { status: 4, jellyfinMediaId: 'lib' } }) });
  h.internal.checkForUnrequestedSeasons = (_data, signal) => { signals.push(signal); return new Promise(() => {}); };
  await h.P.open(1, 'tv');
  h.internal.renderActions({ id: 1, name: 'x', mediaInfo: { status: 4, jellyfinMediaId: 'lib' } }, 'tv', h.modal);
  assert.deepEqual(signals.map(signal => signal.aborted), [true, false]);
});

test('a movie Seerr still calls available but the library lost can be requested again', async t => {
  const h = moreInfoHarness(t, { details: async id => movie(id, { mediaInfo: { status: 5 } }) });
  await h.P.open(1, 'movie');
  const button = h.modal.querySelector('.jellyseerr-request-button');
  assert.ok(button);
  button.click();
  await h.settle();
  assert.deepEqual(plain(h.requests[0].slice(0, 4)), [1, 'movie', {}, false]);

  const owned = moreInfoHarness(t, { details: async id => movie(id, { mediaInfo: available }) });
  await owned.P.open(1, 'movie');
  assert.equal(owned.modal.querySelector('.jellyseerr-request-button'), null);
});

test('a movie requested through the advanced dialog updates the modal; its own request does not fetch again', async t => {
  let fetches = 0;
  const h = moreInfoHarness(t, { details: async id => { fetches++; return movie(id, fetches > 1 ? { mediaInfo: { status: 2 } } : {}); } });
  await h.P.open(1, 'movie');
  // What api.requestMedia announces after the advanced dialog's request.
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '1', mediaType: 'movie', is4k: false } }));
  await h.settle();
  assert.equal(fetches, 2);
  assert.equal(h.modal.querySelector('.jellyseerr-request-button'), null);
  assert.equal(h.modal.querySelector('.je-status-chip').textContent, 'jellyseerr_btn_requested');
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '1', mediaType: 'tv' } }));
  await h.settle();
  assert.equal(fetches, 2, 'another type with the same id is another title');

  let own = 0;
  const direct = moreInfoHarness(t, { details: async id => { own++; return movie(id); }, api: { requestMedia: async function(id) {
    this.announce?.();
    direct.document.dispatchEvent(new direct.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: String(id), mediaType: 'movie' } }));
    return { media: { status: 2 } };
  } } });
  await direct.P.open(1, 'movie');
  direct.modal.querySelector('.jellyseerr-request-button').click();
  await direct.settle();
  assert.equal(own, 1);
});

test('a refresh takes what Seerr no longer sends off the title, and keeps the ratings it fetched itself', async t => {
  let calls = 0;
  const h = moreInfoHarness(t, { ratings: async () => ({ rt: { criticsScore: 80, url: 'https://rt.test/a' } }),
    details: async id => (++calls === 1 ? movie(id, { mediaInfo: { status: 2 }, jeSpoilerGuard: true }) : movie(id)) });
  let seen;
  h.JE.spoilerBlur = { appendSeerrToggle: (_mount, data) => { seen = data; } };
  await h.P.open(1, 'movie');
  await h.settle();
  assert.equal(h.modal.querySelector('.jellyseerr-request-button'), null);
  h.modal.querySelector('.modal-refresh').click();
  await h.settle();
  assert.ok(h.modal.querySelector('.jellyseerr-request-button'));
  assert.equal(seen.mediaInfo, undefined);
  assert.equal(seen.jeSpoilerGuard, undefined);
  assert.equal(seen.ratings.rt.criticsScore, 80);
});

test('Escape belongs to a dialog on top; on its own it dismisses through history, once', async t => {
  const h = moreInfoHarness(t);
  let backs = 0;
  h.window.history.back = () => backs++;
  await h.P.open(1, 'movie');
  h.document.body.classList.add('jellyseerr-modal-is-open');
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(backs, 0);
  h.document.body.classList.remove('jellyseerr-modal-is-open');
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(backs, 1);
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate'));
  assert.equal(h.modal._isClosing, true);
});

test('arrow keys stay in the modal, and keys arrive however the shell sends them', async t => {
  const h = moreInfoHarness(t);
  await h.P.open(1, 'movie');
  h.window.history.back = () => { h.backed = true; };
  // Jellyfin's focus manager listens on the document too: the capture listener goes first.
  const arrow = new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  h.document.dispatchEvent(arrow);
  assert.equal(arrow.defaultPrevented, true);
  const typing = h.document.createElement('input');
  h.modal.appendChild(typing);
  typing.focus();
  const inInput = new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  typing.dispatchEvent(inInput);
  assert.equal(inInput.defaultPrevented, false);
  const shell = Object.assign(new h.window.Event('keydown', { bubbles: true }), { key: 'Escape' });
  h.document.dispatchEvent(shell);
  assert.equal(h.backed, true);
});

test('back with a dialog on top leaves the modal open', async t => {
  const h = moreInfoHarness(t);
  await h.P.open(1, 'movie');
  h.document.body.classList.add('jellyseerr-modal-is-open');
  h.window.dispatchEvent(new h.window.PopStateEvent('popstate'));
  assert.equal(h.modal._isClosing, undefined);
});

test('season links land on the modal they were asked for, and a failed lookup is asked again', async t => {
  const first = deferred();
  let lookups = 0;
  const item = { Items: [{ Id: 'jf-s1', IndexNumber: 1, Name: 'Season One' }] };
  const data = show(1, { mediaInfo: { status: 4, jellyfinMediaId: 'lib', seasons: [{ seasonNumber: 1, status: 5 }] } });
  const h = moreInfoHarness(t, { details: async () => structuredClone(data) });
  h.window.ApiClient.ajax = () => (++lookups === 1 ? first.promise : Promise.resolve(item));
  h.internal.checkForUnrequestedSeasons = async () => false;
  await h.P.open(1, 'tv');
  const old = h.modal;
  h.P.close();
  first.resolve(item);
  await h.settle();
  assert.equal(old.querySelector('[data-season-links]').innerHTML, '');

  let failing = true;
  const retry = moreInfoHarness(t, { details: async () => structuredClone(data) });
  retry.internal.checkForUnrequestedSeasons = async () => false;
  retry.window.ApiClient.ajax = async () => { if (failing) throw new Error('offline'); return item; };
  await retry.P.open(1, 'tv');
  await retry.settle();
  assert.equal(retry.modal.querySelector('.season-link-chip'), null);
  failing = false;
  retry.modal.querySelector('.modal-refresh').click();
  await retry.settle();
  assert.equal(retry.modal.querySelector('.season-link-chip').getAttribute('href'), '#!/details?id=jf-s1');
  assert.equal(retry.modal.querySelector('.season-name').textContent, 'Season One');
});

test('a season lookup for a closed modal never fills it', async t => {
  const pending = deferred();
  const h = moreInfoHarness(t, { details: async id => show(id, { seasons: [{ seasonNumber: 1, episodeCount: 2 }] }), api: { fetchTvSeasonDetails: () => pending.promise } });
  await h.P.open(1, 'tv');
  const old = h.modal;
  h.P.close();
  pending.resolve({ overview: 'late', episodes: [{ airDate: '2020-02-02' }] });
  await h.settle();
  assert.equal(old.querySelector('.season-overview'), null);
});

test('date-only values stay on their day in every time zone; unreadable ones are left out', t => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => { process.env.TZ = zone; });
  const h = moreInfoHarness(t);
  const host = h.document.createElement('div');
  host.innerHTML = h.internal.buildModalContent(movie(1, { releaseDate: '2021-01-01' }), 'movie');
  assert.equal(host.querySelector('.year').textContent, '(2021)');
  const released = [...host.querySelectorAll('.je-more-info-stat-row')].find(row => row.textContent.includes('jellyseerr_modal_release_date'));
  assert.equal(released.querySelector('.je-more-info-stat-value').textContent, 'January 1, 2021');
  host.innerHTML = h.internal.buildModalContent(movie(1, { releaseDate: 'soon' }), 'movie');
  assert.equal(host.querySelector('.year').textContent, '(N/A)');
  assert.doesNotMatch(host.textContent, /Invalid Date|NaN/);
});

test('a backfilled season date keeps its year in every time zone', async t => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => { process.env.TZ = zone; });
  const data = show(1, { seasons: [{ seasonNumber: 1, episodeCount: 8 }] });
  const h = moreInfoHarness(t, { details: async () => data, api: { fetchTvSeasonDetails: async () => ({ episodes: [{ airDate: '2020-01-01' }] }) } });
  await h.P.open(1, 'tv');
  await h.settle();
  assert.match(h.modal.querySelector('.season-meta').textContent, /2020/);
  assert.doesNotMatch(h.modal.querySelector('.season-meta').textContent, /2019/);
});

test('requester avatars keep the path the protected loader recognises', async t => {
  const hydrated = [];
  const h = moreInfoHarness(t, { details: async id => movie(id, { mediaInfo: { status: 2, requests: [
    { requestedBy: { displayName: 'Ann', avatar: '/avatar/a b.png' } }, { requestedBy: { displayName: 'Ann', avatar: '/other.png' } },
    { is4k: true, requestedBy: { displayName: 'Ann' } }, { requestedBy: { username: 'Bob', avatar: 'https://gravatar.test/b' } }, { requestedBy: {} }
  ] } }), je: { helpers: { hydrateAvatarImages: root => hydrated.push(root) } } });
  await h.P.open(1, 'movie');
  const items = [...h.modal.querySelectorAll('.je-requested-by-item')];
  assert.deepEqual(items.map(item => item.querySelector('.je-requested-by-name').textContent), ['Ann', 'Ann (4K)', 'Bob']);
  assert.deepEqual(items.map(item => item.querySelector('img')?.getAttribute('data-avatar-src')), ['/JellyfinEnhanced/proxy/avatar?path=%2Favatar%2Fa%20b.png', undefined, 'https://gravatar.test/b']);
  assert.equal(hydrated.length, 1);
});

test('an unknown media type fails like a missing title, without asking Seerr', async t => {
  const asked = [];
  const h = moreInfoHarness(t, { details: async id => { asked.push(id); return movie(id); } });
  h.expectConsoleError(/Failed to load media information/);
  await h.P.open(1, 'person');
  assert.equal(asked.length, 0);
  assert.equal(h.errors.length, 1);
  assert.equal(h.modal, null);
});

test('a TMDB and a Seerr link use the configured base, sub-path included', async t => {
  const h = moreInfoHarness(t, { api: { resolveJellyseerrBaseUrl: () => 'https://home.test/seerr' }, details: async id => movie(id, { imdbId: 'tt1', mediaInfo: available }) });
  await h.P.open(1, 'movie');
  const links = Object.fromEntries([...h.modal.querySelectorAll('.je-more-info-fact')].map(link => [link.className.replace('je-more-info-fact ', ''), link.getAttribute('href')]));
  assert.equal(links.jellyseerr, 'https://home.test/seerr/movie/1');
  assert.equal(links.jellyfin, '#!/details?id=lib-1');
  assert.equal(links.simkl, 'https://api.simkl.com/redirect?to=Simkl&imdb=tt1');
  assert.equal(links.imdb, 'https://www.imdb.com/title/tt1');
});

test('the shared registry and public facade keep their names, and the modal its close flag', async t => {
  const h = moreInfoHarness(t);
  for (const name of ['fetchRatings', 'fetchMediaDetails', 'getContentRating', 'showError', 'formatCurrency', 'backfillSeasonMetadata', 'getSeasonStatusInfo', 'getSeasonJellyfinId',
    'buildSeasonAvailabilityLinks', 'fetchJellyfinSeasonMap', 'enrichSeasonCardsWithJellyfinLinks', 'checkForUnrequestedSeasons', 'buildSeasonsSection', 'buildRatingLogos', 'buildMediaFacts',
    'buildStatusChip', 'resolveStatusLabel', 'buildDownloadBars', 'buildModalContent', 'buildRightPanel', 'buildStreamingProviders', 'buildCollectionCard', 'buildKeywordsSection', 'buildCrewSection',
    'buildTrailersSection', 'buildCastSection', 'buildPersonPlaceholder', 'buildTvActions', 'buildSingleTv4kButton', 'buildTvRequestMoreButton', 'buildSingle4kButton', 'buildMovieActions',
    'mountRequestedChip', 'maybeRenderMoreInfoQuotaChip', 'renderActions']) assert.equal(typeof h.internal[name], 'function', name);
  for (const name of ['open', 'close', 'checkForUnrequestedSeasons']) assert.equal(typeof h.P[name], 'function', name);
  await h.P.open(1, 'movie');
  const modal = h.modal;
  h.P.close();
  // Spoiler Guard's toggle reads this flag to refuse a modal on its way out.
  assert.equal(modal._isClosing, true);
  h.clock.run(300);
  assert.equal(h.modal, null);
  assert.equal(modal.isConnected, false);
});

test('the exit announces the close that releases held-back work, and a replacement outlives it', async t => {
  const h = moreInfoHarness(t);
  let closed = 0;
  h.document.addEventListener('jellyseerr-more-info-closed', () => closed++);
  await h.P.open(1, 'movie');
  await h.P.open(2, 'movie');
  h.clock.run(300);
  assert.equal(closed, 1);
  assert.equal(h.modal.dataset.tmdbId, '2');
  assert.equal(h.document.querySelectorAll('.je-more-info-modal').length, 1);
});

test('the stylesheet is installed once, under its id', t => {
  const h = moreInfoHarness(t);
  const css = [];
  h.JE.core.ui.injectCss = (id, text) => css.push([id, text]);
  h.load('jellyseerr/moreinfo/more-info-modal-styles.js');
  assert.equal(css[0][0], 'je-more-info-modal-styles');
  assert.match(css[0][1], /\.je-more-info-modal \{/);
  assert.equal(strictEscape(css[0][1]).length > css[0][1].length, true);
});
