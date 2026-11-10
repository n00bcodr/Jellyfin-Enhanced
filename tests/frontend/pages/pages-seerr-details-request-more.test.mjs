import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';
import { sessionFixture } from '../helpers/seerr-details.mjs';

// item-details.js: the Request More button by the Seasons heading of a Series.
const seasons = (title = 'Seasons') => `<div id="listChildrenCollapsible"><h2 class="sectionTitle sectionTitle-cards"><span>${title}</span></h2></div>`;
const view = (cls, inner) => `<div class="libraryPage ${cls}">${inner}</div>`;
const SERIES = { Type: 'Series', Name: 'Show', ProviderIds: { Tmdb: '77' } };

function setup(t, { html = view('', seasons()), item = async () => SERIES, check = async () => true, details = async () => ({ id: 77, name: 'Show' }), status = { active: true }, config = {}, url = 'http://jellyfin.test/web/index.html#!/details?id=s1' } = {}) {
  const { session, switchUser, moveEpoch } = sessionFixture();
  const teardowns = [], navs = [], views = [], picks = [], checks = [];
  const counts = { details: 0, status: 0 };
  const h = createHarness({ html, url, JE: {
    pluginConfig: { JellyseerrEnabled: true, ...config }, t: key => key, session,
    helpers: { getItemCached: item, onBodyMutation: () => ({ unsubscribe() {} }) },
    jellyseerrAPI: { checkUserStatus: async () => { counts.status++; return status; }, fetchTvShowDetails: async (...args) => { counts.details++; return details(...args); } },
    jellyseerrUI: { showSeasonSelectionModal: (...args) => picks.push(args) },
    jellyseerrMoreInfo: { checkForUnrequestedSeasons: (data, signal) => { checks.push({ data, signal }); return check(data, signal); } },
    core: { lifecycle: { register: () => ({ onTeardown: fn => teardowns.push(fn), teardownOn() {} }) }, navigation: { onNavigate: fn => navs.push(fn), onViewPage: fn => views.push(fn) } }
  } });
  t.after(() => h.close());
  const frames = [];
  h.window.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
  h.load('jellyseerr/item-details.js');
  return { ...h, picks, checks, counts, switchUser, moveEpoch, frames, button: (root = h.document) => root.querySelector('.je-series-request-more-btn'),
    async run() { for (const fn of frames.splice(0)) fn(); for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); },
    navigate(hash) { h.window.history.pushState(null, '', hash); for (const fn of teardowns) fn(); for (const fn of navs) fn(); },
    async viewshow(target, id) {
      const raw = new h.window.CustomEvent('viewshow', { bubbles: true, detail: { params: { id } } });
      target.dispatchEvent(raw);
      for (const fn of views) fn(undefined, undefined, undefined, null, raw);
    } };
}

test('a show with seasons left gets the button, which opens the picker for that show', async t => {
  const h = setup(t);
  await h.run();
  const button = h.button();
  assert.ok(button);
  assert.ok(button.parentElement.classList.contains('je-series-request-more-heading'));
  assert.equal(button.title, 'jellyseerr_btn_request_more');
  assert.equal(h.document.getElementById('je-series-request-more-styles')?.tagName, 'STYLE');
  button.click();
  assert.deepEqual(h.picks.map(args => args.slice(0, 3)), [[77, 'tv', 'Show']]);
  assert.equal(h.picks[0][3].id, 77);
});

test('a show with nothing left gets none, and is not asked about again on the same page', async t => {
  const h = setup(t, { check: async () => false });
  await h.run();
  assert.equal(h.button(), null);
  await h.viewshow(h.document.querySelector('.libraryPage'), 's1');
  await h.run();
  assert.equal(h.checks.length, 1);
  assert.equal(h.counts.details, 1);
});

test('two starts for a page share one check', async t => {
  const release = deferred();
  const h = setup(t, { check: () => release.promise });
  await h.viewshow(h.document.querySelector('.libraryPage'), 's1');
  await h.run();
  release.resolve(true);
  await h.run();
  assert.equal(h.checks.length, 1);
  assert.equal(h.document.querySelectorAll('.je-series-request-more-btn').length, 1);
});

for (const [name, config, status] of [['off in settings', { JellyseerrShowRequestMoreOnSeries: false }, { active: true }], ['Seerr integration off', { JellyseerrEnabled: false }, { active: true }], ['Seerr inactive', {}, { active: false }]]) {
  test(`${name}: no check runs`, async t => {
    const h = setup(t, { config, status });
    await h.run();
    assert.equal(h.checks.length, 0);
    assert.equal(h.button(), null);
  });
}

test('only a series with a TMDB id is checked', async t => {
  for (const item of [{ Type: 'Movie', ProviderIds: { Tmdb: '1' } }, { Type: 'Series', Name: 'x', ProviderIds: {} }]) {
    const h = setup(t, { item: async () => item });
    await h.run();
    assert.equal(h.checks.length, 0);
  }
});

test('leaving the page cancels the check, its lookups included', async t => {
  const release = deferred();
  const h = setup(t, { check: () => release.promise });
  await h.run();
  h.navigate('#!/home');
  assert.equal(h.checks[0].signal.aborted, true);
  release.resolve(true);
  await h.run();
  assert.equal(h.button(), null);
});

test('an account change stops the check: nothing is added for the new account', async t => {
  const release = deferred();
  const h = setup(t, { check: () => release.promise });
  await h.run();
  h.switchUser();
  assert.equal(h.checks[0].signal.aborted, true, 'the old account\'s lookups stop too');
  release.resolve(true);
  await h.run();
  assert.equal(h.button(), null);
});

test('work that outlives an account change stops even before the change is announced', async t => {
  const release = deferred();
  const h = setup(t, { check: () => release.promise });
  await h.run();
  h.moveEpoch();
  release.resolve(true);
  await h.run();
  assert.equal(h.button(), null);
});

test('a button left on a page from an old account does nothing', async t => {
  const h = setup(t);
  await h.run();
  const button = h.button();
  h.moveEpoch();
  button.click();
  assert.equal(h.picks.length, 0);
});

test('the heading of a view shown for another item is not this item\'s', async t => {
  const h = setup(t, { html: view('old', seasons()) });
  const outgoing = h.document.querySelector('.old');
  await h.viewshow(outgoing, 'previous');
  await h.run();
  assert.equal(h.button(outgoing), null, 'Jellyfin has not hidden the outgoing view yet');
});

test('a frame after the URL moved on starts no check for the old item', async t => {
  const h = setup(t);
  h.window.history.pushState(null, '', '#!/home');
  await h.run();
  assert.equal(h.checks.length, 0);
});

test('a page that already has the button keeps one', async t => {
  const h = setup(t, { html: view('', seasons().replace('</span>', '</span><button class="je-series-request-more-btn"></button>')) });
  await h.run();
  assert.equal(h.document.querySelectorAll('.je-series-request-more-btn').length, 1);
  await h.viewshow(h.document.querySelector('.libraryPage'), 's1');
  await h.run();
  assert.equal(h.checks.length, 1);
});
