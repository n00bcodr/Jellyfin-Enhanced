// Requests & downloads, phase 4e: acquisition badges on poster cards. The server resolves one stamp per viewer
// (upgraded / new / fourK); the web paints it with JE.arrStatus.buildBadge(status, stamp): at most one acquisition
// chip, the in-progress chips (attention, download ring, almost ready) first, season ✓/◐ kept in front. Cards read
// stamps next to statuses only when the admin switch and the person's preference allow it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, deferred, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = ['arr/status/status-core.js', 'arr/status/status-cards.js', 'arr/status/status-styles.js'];

/** JE.t as the real one behaves: the English string with {name} parameters filled in. */
function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

const STAMPS = {
  upgraded: { icon: 'upgrade', word: en.arr_badge_upgraded, title: en.arr_badge_upgraded_title },
  new: { icon: 'fiber_new', word: null, title: en.arr_badge_new_title },
  fourK: { icon: '4k', word: null, title: en.arr_badge_fourk_title }
};

/**
 * The status modules with a recording plugin transport. `responses(path, n)` answers each request (an Error throws,
 * a promise is awaited).
 */
function setup(t, { html = '', config = {}, settings, responses = () => ({ items: [] }), apiClient = {}, globals = {} } = {}) {
  const calls = [];
  const observers = [];
  const userChange = [];
  const h = createHarness({
    html,
    url: 'http://jellyfin.test/web/index.html#/home',
    apiClient,
    globals: {
      IntersectionObserver: class {
        constructor(fn) { this.fn = fn; this.observed = new Set(); observers.push(this); }
        observe(el) { this.observed.add(el); }
        unobserve(el) { this.observed.delete(el); }
        disconnect() { this.observed.clear(); }
      },
      ...globals
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrStatusPosterBadges: true, ...config },
      currentSettings: { ...settings },
      t: translate,
      helpers: { debounce: fn => fn, onBodyMutation: () => ({ unsubscribe() {} }) },
      core: {
        api: {
          plugin: async (path, options) => {
            calls.push({ path, options });
            const answer = await responses(path, calls.length);
            if (answer instanceof Error) throw answer;
            return answer;
          }
        },
        navigation: { onNavigate: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: (k, fn) => userChange.push(fn) }
    }
  });
  t.after(() => h.close());
  for (const m of MODULES) h.load(m);
  const cards = h.JE.internals.arrStatusCards;
  return {
    ...h, calls, observers, userChange, cards,
    S: h.JE.arrStatus,
    statusCalls: () => calls.filter(c => c.path.startsWith('/acquire/status')),
    stampCalls: () => calls.filter(c => c.path.startsWith('/acquire/stamps')),
    /** Starts the surface and brings every card into view; resolves after the first batch. */
    async show() {
      h.JE.initializeArrStatus();
      cards.scan();
      const io = observers[0];
      if (!io) return;
      io.fn([...io.observed].map(target => ({ isIntersecting: true, target })));
      await cards.flush();
    }
  };
}

const id = i => i.toString(16).padStart(32, '0');
function cardsHtml(types) {
  return types.map((type, i) => `<div class="card" data-id="${id(i)}" data-type="${type}"><div class="cardBox"><div class="cardScalable"></div></div></div>`).join('');
}
const idsOf = path => decodeURIComponent(/ids=([^&]*)/.exec(path)[1]).split(',');
const chips = badge => [...badge.querySelectorAll('.je-arr-badge-chip, .je-arr-ring')].map(c => c.className);

// ------------------------------------------------------------------ buildBadge

const downloading = { key: 'm1', kind: 'movie', stage: 'downloading', progress: { percent: 42 } };
const attention = { key: 'm2', kind: 'movie', stage: 'almostReady', attention: true };
const almost = { key: 'm3', kind: 'movie', stage: 'almostReady' };
const seriesBusy = { key: 'x', kind: 'series', stage: 'ready', summary: { downloading: 2 } };
const seriesAlmost = { key: 'y', kind: 'series', stage: 'ready', summary: { almostReady: 1 } };
const quiet = { key: 'q', kind: 'movie', stage: 'ready', quiet: true };

test('the in-progress badges beat every stamp: attention, the download ring, almost ready', t => {
  const { S } = setup(t);
  for (const stamp of Object.keys(STAMPS)) {
    for (const [status, expect] of [[downloading, 'je-arr-ring'], [attention, 'je-arr-tone-attention'], [almost, 'je-arr-tone-almostReady'], [seriesBusy, 'je-arr-ring'], [seriesAlmost, 'je-arr-tone-almostReady']]) {
      const badge = S.buildBadge(status, stamp);
      assert.equal(badge.querySelector('.je-arr-badge-stamp'), null, `${status.key} + ${stamp}`);
      const shown = chips(badge);
      assert.equal(shown.length, 1);
      assert.ok(shown[0].includes(expect), `${status.key} + ${stamp}: ${shown[0]}`);
      assert.equal(badge.outerHTML, S.buildBadge(status).outerHTML, 'the stamp changes nothing');
    }
  }
});

test('a stamp alone (no status, or a quiet one) draws exactly one stamp chip: icon, word, title, tone', t => {
  const { S } = setup(t);
  for (const [stamp, want] of Object.entries(STAMPS)) {
    for (const status of [null, undefined, quiet, { key: 'n', kind: 'movie', stage: 'notHere' }]) {
      const badge = S.buildBadge(status, stamp);
      assert.ok(badge, `${stamp} with ${JSON.stringify(status)}`);
      const all = badge.querySelectorAll('.je-arr-badge-chip, .je-arr-ring');
      assert.equal(all.length, 1);
      const chip = all[0];
      assert.equal(chip.className, `je-arr-badge-chip je-arr-tone-${stamp} je-arr-badge-stamp`);
      assert.equal(chip.querySelector('.material-icons.je-arr-badge-icon').textContent, want.icon);
      assert.equal(chip.querySelector('.material-icons').getAttribute('aria-hidden'), 'true');
      // The fiber_new and 4k glyphs spell their word; only Upgraded's arrow carries one.
      assert.equal(chip.querySelector('.je-arr-badge-word')?.textContent ?? null, want.word);
      assert.equal(chip.title, want.title);
      assert.equal(badge.getAttribute('role'), 'img');
      assert.equal(badge.getAttribute('aria-label'), want.title);
      assert.equal(badge.dataset.jeArrKey, status?.key || '');
    }
  }
  // The server sends one stamp (Upgraded > New > 4K already applied); each draws its own glyph (and Upgraded its word).
  same(Object.keys(STAMPS).map(s => S.buildBadge(null, s).querySelector('.je-arr-badge-word')?.textContent ?? null), ['Upgraded', null, null]);
});

test('no stamp, or one this client does not know, draws exactly what it drew before', t => {
  const { S } = setup(t);
  // outerHTML of the unmodified phase-1 buildBadge(status) for these statuses.
  const before = {
    m2: '<div class="je-arr-badge" data-je-arr-key="m2" role="img" aria-label="Taking longer than usual"><span class="je-arr-badge-chip je-arr-tone-attention" title="Taking longer than usual"><span class="material-icons je-arr-badge-icon" aria-hidden="true">schedule</span></span></div>',
    m3: '<div class="je-arr-badge" data-je-arr-key="m3" role="img" aria-label="Almost ready"><span class="je-arr-badge-chip je-arr-tone-almostReady" title="Almost ready"><span class="material-icons je-arr-badge-icon" aria-hidden="true">hourglass_bottom</span></span></div>',
    s1: '<div class="je-arr-badge" data-je-arr-key="s1" role="img" aria-label="All episodes ready"><span class="je-arr-badge-chip je-arr-tone-ready" title="All episodes ready"><span class="material-icons je-arr-badge-icon" aria-hidden="true">check</span></span></div>',
    s3: '<div class="je-arr-badge" data-je-arr-key="s3" role="img" aria-label="4 of 10 ready, Downloading 60%"><span class="je-arr-badge-chip je-arr-tone-partial" title="4 of 10 ready">◐ 4/10</span><span class="je-arr-ring" title="Downloading 60%"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="je-arr-ring-track" cx="18" cy="18" r="15"></circle><circle class="je-arr-ring-bar" cx="18" cy="18" r="15" stroke-dasharray="56.5 94.2"></circle></svg><span class="je-arr-ring-text">60</span></span></div>'
  };
  const statuses = [attention, almost,
    { key: 's1', kind: 'season', stage: 'ready', quiet: true, summary: { aired: 6, ready: 6, missing: 0 } },
    { key: 's3', kind: 'season', stage: 'downloading', summary: { aired: 10, ready: 4, missing: 4, downloading: 1 }, progress: { percent: 60 } }];
  for (const status of statuses) {
    for (const stamp of [undefined, null, '', 'bogus', '__proto__', 'toString', 'constructor']) {
      assert.equal(S.buildBadge(status, stamp).outerHTML, before[status.key], `${status.key} / ${String(stamp)}`);
    }
  }
  for (const stamp of [undefined, null, 'bogus', '__proto__', 'toString']) {
    assert.equal(S.buildBadge(quiet, stamp), null);
    assert.equal(S.buildBadge(null, stamp), null);
  }
});

test('season cards keep ✓ or ◐ first and add the stamp; a downloading season shows the ring and no stamp', t => {
  const { S } = setup(t);
  const done = S.buildBadge({ key: 's1', kind: 'season', stage: 'ready', quiet: true, summary: { aired: 6, ready: 6, missing: 0 } }, 'new');
  same(chips(done), ['je-arr-badge-chip je-arr-tone-ready', 'je-arr-badge-chip je-arr-tone-new je-arr-badge-stamp']);
  assert.equal(done.getAttribute('aria-label'), `All episodes ready, ${STAMPS.new.title}`);

  const partial = S.buildBadge({ key: 's2', kind: 'season', stage: 'ready', summary: { aired: 10, ready: 7, missing: 3 } }, 'fourK');
  same(chips(partial), ['je-arr-badge-chip je-arr-tone-partial', 'je-arr-badge-chip je-arr-tone-fourK je-arr-badge-stamp']);
  assert.equal(partial.querySelector('.je-arr-badge-chip').textContent, '◐ 7/10');
  assert.equal(partial.getAttribute('aria-label'), `7 of 10 ready, ${STAMPS.fourK.title}`);

  const busy = S.buildBadge({ key: 's3', kind: 'season', stage: 'downloading', summary: { aired: 10, ready: 4, missing: 4, downloading: 1 }, progress: { percent: 60 } }, 'upgraded');
  same(chips(busy), ['je-arr-badge-chip je-arr-tone-partial', 'je-arr-ring']);
  assert.equal(busy.querySelector('.je-arr-badge-stamp'), null);
});

test('the stamp tones and the word are styled, TV sizes included', t => {
  const h = setup(t);
  const css = h.JE.internals.arrStatusStyles.CSS;
  assert.match(css, /\.je-arr-tone-new \{ --je-arr-tone: #52b54b; \}/);
  assert.match(css, /\.je-arr-tone-upgraded \{ --je-arr-tone: #22d3ee; \}/);
  assert.match(css, /\.je-arr-tone-fourK \{ --je-arr-tone: #e5a00d; \}/);
  assert.match(css, /\n\.je-arr-badge-word \{[^}]*font-size: 11px;[^}]*font-weight: 700;/);
  assert.match(css, /\.layout-tv \.je-arr-badge-word \{ font-size: 14px; \}/);
});

// ------------------------------------------------------------------ the stamps read

test('stampsEnabled follows the admin switch, the person\'s preference and a refused read', async t => {
  assert.equal(setup(t).S.stampsEnabled(), false, 'switch absent');
  assert.equal(setup(t, { config: { ArrAcquisitionBadgesEnabled: false } }).S.stampsEnabled(), false);
  assert.equal(setup(t, { config: { ArrAcquisitionBadgesEnabled: 'true' } }).S.stampsEnabled(), false, 'only a real true');
  assert.equal(setup(t, { config: { ArrAcquisitionBadgesEnabled: true } }).S.stampsEnabled(), true);
  assert.equal(setup(t, { config: { ArrAcquisitionBadgesEnabled: true }, settings: { acquisitionBadges: null } }).S.stampsEnabled(), true, 'null follows the household');
  assert.equal(setup(t, { config: { ArrAcquisitionBadgesEnabled: true }, settings: { acquisitionBadges: false } }).S.stampsEnabled(), false);
  const fallback = setup(t, { config: { ArrAcquisitionBadgesEnabled: true } });
  fallback.JE.currentSettings = undefined;
  fallback.JE.userConfig = { settings: { acquisitionBadges: false } };
  assert.equal(fallback.S.stampsEnabled(), false, 'falls back to the saved settings');

  const h = setup(t, { config: { ArrAcquisitionBadgesEnabled: true }, responses: () => Object.assign(new Error('HTTP 403'), { status: 403, responseJSON: { code: 'feature_disabled' } }) });
  assert.equal(await h.S.fetchStamps([id(1)]), null);
  assert.equal(h.S.stampsEnabled(), false, 'feature_disabled switches stamps off');
  assert.equal(h.S.enabled(), true, 'the status routes stay on');
  assert.equal(await h.S.fetchStamps([id(1)]), null);
  assert.equal(h.calls.length, 1, 'no further stamps reads');
  h.userChange.forEach(fn => fn());
  assert.equal(h.S.stampsEnabled(), true, 'a user switch asks again');
});

test('fetchStamps: one low-priority read of the stamps route, synthetic ids left out', async t => {
  const h = setup(t, { config: { ArrAcquisitionBadgesEnabled: true }, responses: () => ({ items: [{ itemId: id(1), stamp: 'new' }] }) });
  h.JE.titleDetails = { isSynthetic: x => x.startsWith('je') };
  same(await h.S.fetchStamps([id(1), 'je-synthetic', id(2)]), { items: [{ itemId: id(1), stamp: 'new' }] });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, `/acquire/stamps?ids=${id(1)},${id(2)}`);
  assert.equal(h.calls[0].options.priority, 'low');
  assert.equal(h.calls[0].options.skipRetry, true);
  same(await h.S.fetchStamps(['je-only']), { items: [] });
  same(await h.S.fetchStamps([]), { items: [] });
  assert.equal(h.calls.length, 1, 'nothing to ask: no request');

  const off = setup(t);
  assert.equal(await off.S.fetchStamps([id(1)]), null);
  assert.equal(off.calls.length, 0, 'flag off: no request');
});

// ------------------------------------------------------------------ poster cards

const statusAnswer = (path, map) => ({ items: idsOf(path).filter(i => map[i]).map(i => ({ itemId: i, ...map[i] })) });
const stampAnswer = (path, map) => ({ items: idsOf(path).filter(i => map[i]).map(i => ({ itemId: i, stamp: map[i] })) });

test('with the acquisition switch off the cards read statuses only, exactly as before', async t => {
  const statuses = { [id(0)]: { key: 'movie:tmdb:1', kind: 'movie', stage: 'almostReady' } };
  for (const config of [{}, { ArrAcquisitionBadgesEnabled: false }, { ArrAcquisitionBadgesEnabled: false, ArrNativeStampsEnabled: true }]) {
    let subscribed = 0;
    const h = setup(t, { html: cardsHtml(['Movie', 'Movie']), config, apiClient: { subscribe: () => { subscribed++; return () => {}; } }, responses: path => statusAnswer(path, statuses) });
    await h.show();
    assert.equal(h.stampCalls().length, 0, JSON.stringify(config));
    assert.equal(h.statusCalls().length, 1);
    assert.equal(subscribed, 0, 'no watch-state listener');
    const card = h.document.querySelectorAll('.card')[0];
    assert.equal(card.querySelector('.je-arr-badge').outerHTML.includes('je-arr-badge-stamp'), false);
    assert.equal(h.document.querySelectorAll('.je-arr-badge').length, 1);
    same(h.cards.cache.get(id(0)), { status: { itemId: id(0), ...statuses[id(0)] }, stamp: null, at: h.cards.cache.get(id(0)).at });
  }
  const none = setup(t, { html: cardsHtml(['Movie']), config: { ArrStatusPosterBadges: false } });
  await none.show();
  assert.equal(none.observers.length, 0);
  assert.equal(none.calls.length, 0);
});

test('stamps are read only when the switch and the person allow; statuses only with the phase-1 poster badges', async t => {
  const stamps = { [id(0)]: 'new' };
  const hidden = setup(t, { html: cardsHtml(['Movie']), config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false }, settings: { acquisitionBadges: false } });
  await hidden.show();
  assert.equal(hidden.observers.length, 0, 'nothing to show: the surface never starts');
  assert.equal(hidden.calls.length, 0);

  const hiddenWithStatus = setup(t, { html: cardsHtml(['Movie']), config: { ArrAcquisitionBadgesEnabled: true }, settings: { acquisitionBadges: false } });
  await hiddenWithStatus.show();
  assert.equal(hiddenWithStatus.stampCalls().length, 0);
  assert.equal(hiddenWithStatus.statusCalls().length, 1);

  const only = setup(t, { html: cardsHtml(['Movie', 'Movie']), config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false }, responses: path => stampAnswer(path, stamps) });
  await only.show();
  assert.equal(only.statusCalls().length, 0, 'poster badges off: no status read');
  assert.equal(only.stampCalls().length, 1);
  same(idsOf(only.stampCalls()[0].path), [id(0), id(1)]);
  assert.equal(only.stampCalls()[0].options.priority, 'low');
  const [first, second] = only.document.querySelectorAll('.card');
  assert.ok(first.querySelector('.cardScalable > .je-arr-badge .je-arr-badge-stamp.je-arr-tone-new'));
  assert.equal(second.querySelector('.je-arr-badge'), null);
});

test('statuses and stamps are read in parallel and painted together, the in-progress badge first', async t => {
  const pending = { status: deferred(), stamps: deferred() };
  const h = setup(t, {
    html: cardsHtml(['Movie', 'Movie', 'Series']),
    config: { ArrAcquisitionBadgesEnabled: true },
    responses: path => (path.startsWith('/acquire/stamps') ? pending.stamps.promise : pending.status.promise)
  });
  const shown = h.show();
  await nextTurn();
  assert.equal(h.statusCalls().length, 1);
  assert.equal(h.stampCalls().length, 1, 'both requests are out before either answers');
  pending.stamps.resolve({ items: [{ itemId: id(0), stamp: 'upgraded' }, { itemId: id(1), stamp: 'upgraded' }, { itemId: id(2).replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-').toUpperCase(), stamp: 'fourK' }] });
  pending.status.resolve({ items: [{ itemId: id(0), key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', progress: { percent: 10 } }, { itemId: id(1), key: 'movie:tmdb:2', kind: 'movie', stage: 'ready', quiet: true }] });
  await shown;
  const cards = h.document.querySelectorAll('.card');
  assert.ok(cards[0].querySelector('.je-arr-ring'));
  assert.equal(cards[0].querySelector('.je-arr-badge-stamp'), null, 'downloading: the ring wins');
  assert.ok(cards[1].querySelector('.je-arr-badge-stamp.je-arr-tone-upgraded'));
  assert.ok(cards[2].querySelector('.je-arr-badge-stamp.je-arr-tone-fourK'), 'dashed upper-case ids are matched');
  assert.equal(h.cards.cache.get(id(1)).stamp, 'upgraded');
  // Painting again from the cache gives the same badge.
  const before = cards[1].querySelector('.je-arr-badge').outerHTML;
  h.observers[0].fn([{ isIntersecting: true, target: cards[1] }]);
  assert.equal(cards[1].querySelector('.je-arr-badge').outerHTML, before);
  assert.equal(h.calls.length, 2);
});

test('a failed stamps read keeps the statuses painted (and the other way round), then both are read again', async t => {
  let failStamps = true;
  let failStatus = false;
  const h = setup(t, {
    html: cardsHtml(['Movie', 'Movie']),
    config: { ArrAcquisitionBadgesEnabled: true },
    responses: path => {
      if (path.startsWith('/acquire/stamps')) return failStamps ? Object.assign(new Error('HTTP 500'), { status: 500 }) : { items: [{ itemId: id(1), stamp: 'new' }] };
      return failStatus ? Object.assign(new Error('HTTP 500'), { status: 500 }) : { items: [{ itemId: id(0), key: 'movie:tmdb:1', kind: 'movie', stage: 'almostReady' }] };
    }
  });
  await h.show();
  const cards = h.document.querySelectorAll('.card');
  assert.equal(cards[0].querySelector('.je-arr-badge .material-icons').textContent, 'hourglass_bottom', 'statuses painted');
  assert.equal(cards[1].querySelector('.je-arr-badge'), null);
  assert.equal(h.cards.cache.has(id(0)), false, 'the batch is asked again after a pause');

  // The retry (driven here directly): stamps answer now, statuses fail; the status badge stays, the stamp arrives.
  failStamps = false;
  failStatus = true;
  h.cards.refreshKeys([]);
  for (const card of cards) h.observers[0].fn([{ isIntersecting: true, target: card }]);
  await h.cards.flush();
  assert.equal(cards[0].querySelector('.je-arr-badge .material-icons').textContent, 'hourglass_bottom', 'a failed status read keeps what was shown');
  assert.ok(cards[1].querySelector('.je-arr-badge-stamp.je-arr-tone-new'));

  // Both fail: nothing is repainted (as before).
  failStamps = true;
  for (const card of cards) h.observers[0].fn([{ isIntersecting: true, target: card }]);
  await h.cards.flush();
  assert.ok(cards[1].querySelector('.je-arr-badge-stamp'));
  assert.ok(cards[0].querySelector('.je-arr-badge'));
});

test('a 403 from the stamps route switches stamps off for the page load; statuses carry on, no retry', async t => {
  const h = setup(t, {
    html: cardsHtml(['Movie']),
    config: { ArrAcquisitionBadgesEnabled: true },
    responses: path => (path.startsWith('/acquire/stamps')
      ? Object.assign(new Error('HTTP 403'), { status: 403, responseJSON: { code: 'feature_disabled' } })
      : { items: [{ itemId: id(0), key: 'movie:tmdb:1', kind: 'movie', stage: 'almostReady' }] })
  });
  await h.show();
  assert.equal(h.S.stampsEnabled(), false);
  assert.ok(h.cards.cache.has(id(0)), 'not a failure: nothing to retry');
  assert.equal(h.document.querySelector('.je-arr-badge .material-icons').textContent, 'hourglass_bottom');
  h.cards.refreshKeys(['movie:tmdb:1']);
  await h.cards.flush();
  assert.equal(h.stampCalls().length, 1, 'no second stamps read');
  assert.equal(h.statusCalls().length, 2);

  // Stamps alone: a refused read leaves the cards bare and asks nothing more.
  const only = setup(t, { html: cardsHtml(['Movie']), config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false }, responses: () => Object.assign(new Error('HTTP 403'), { status: 403 }) });
  await only.show();
  assert.equal(only.calls.length, 1);
  only.observers[0].fn([{ isIntersecting: true, target: only.document.querySelector('.card') }]);
  await only.cards.flush();
  assert.equal(only.calls.length, 1);
  assert.equal(only.document.querySelector('.je-arr-badge'), null);
});

test('a user switch clears the stamps and their badges', async t => {
  const h = setup(t, { html: cardsHtml(['Movie']), config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false }, responses: path => stampAnswer(path, { [id(0)]: 'new' }) });
  await h.show();
  assert.ok(h.document.querySelector('.je-arr-badge-stamp'));
  h.userChange.forEach(fn => fn());
  assert.equal(h.document.querySelector('.je-arr-badge'), null);
  assert.equal(h.cards.cache.size, 0);
});

test('the person\'s own watch state changing (UserDataChanged) re-reads those cards: a watched title loses its badge', async t => {
  let stamps = { [id(0)]: 'new', [id(1)]: 'upgraded', [id(2)]: 'new' };
  const handlers = [];
  let unsubscribed = 0;
  const h = setup(t, {
    html: cardsHtml(['Movie', 'Movie', 'Series']),
    config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false },
    apiClient: { subscribe: (types, fn) => { handlers.push({ types: [...types], fn }); return () => { unsubscribed++; }; } },
    responses: path => stampAnswer(path, stamps)
  });
  await h.show();
  same(handlers.map(x => x.types), [['UserDataChanged']], 'Jellyfin 12: ApiClient.subscribe');
  const cards = h.document.querySelectorAll('.card');
  assert.equal(h.document.querySelectorAll('.je-arr-badge-stamp').length, 3);

  stamps = { [id(1)]: 'upgraded', [id(2)]: 'new' };
  handlers[0].fn({ MessageType: 'UserDataChanged', Data: { UserId: 'user-a', UserDataList: [{ ItemId: id(0).toUpperCase(), Played: false }] } });
  await h.cards.flush();
  same(idsOf(h.stampCalls().at(-1).path), [id(0)], 'only the changed card is read again');
  assert.equal(cards[0].querySelector('.je-arr-badge'), null);
  assert.ok(cards[1].querySelector('.je-arr-badge-stamp'));

  // An episode (not on the page) was watched: a stamped series card may lose its badge too.
  stamps = { [id(1)]: 'upgraded' };
  handlers[0].fn({ MessageType: 'UserDataChanged', Data: { UserDataList: [{ ItemId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', Played: true }] } });
  await h.cards.flush();
  same(idsOf(h.stampCalls().at(-1).path), [id(2)]);
  assert.equal(cards[2].querySelector('.je-arr-badge'), null);
  assert.ok(cards[1].querySelector('.je-arr-badge-stamp'), 'a movie card is not re-read for someone else\'s item');

  const calls = h.calls.length;
  handlers[0].fn({ Data: { UserDataList: [] } });
  handlers[0].fn({});
  assert.equal(h.cards.cache.size, 3);
  await h.cards.flush();
  assert.equal(h.calls.length, calls, 'nothing changed: nothing read');

  // A user switch listens afresh.
  h.userChange.forEach(fn => fn());
  assert.equal(unsubscribed, 1);
  assert.equal(handlers.length, 2);
});

test('on Jellyfin 10.11 the watch-state change comes through jellyfin-web\'s Events on the ApiClient', async t => {
  const listeners = [];
  const Events = { on: (obj, type, fn) => listeners.push({ obj, type, fn }), off: (obj, type, fn) => { const i = listeners.findIndex(l => l.fn === fn); if (i >= 0) listeners.splice(i, 1); } };
  let stamps = { [id(0)]: 'new' };
  const h = setup(t, { html: cardsHtml(['Movie']), config: { ArrAcquisitionBadgesEnabled: true }, globals: { Events }, responses: path => (path.startsWith('/acquire/stamps') ? stampAnswer(path, stamps) : { items: [] }) });
  await h.show();
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].obj, h.window.ApiClient);
  assert.equal(listeners[0].type, 'message');
  stamps = {};
  listeners[0].fn({}, { MessageType: 'Play', Data: { UserDataList: [{ ItemId: id(0) }] } });
  assert.ok(h.cards.cache.has(id(0)), 'other messages are ignored');
  listeners[0].fn({}, { MessageType: 'UserDataChanged', Data: { UserDataList: [{ ItemId: id(0), Played: true }] } });
  await h.cards.flush();
  assert.equal(h.document.querySelector('.je-arr-badge'), null);
  assert.equal(h.statusCalls().length, 2, 'the status is read again with it');
  h.userChange.forEach(fn => fn());
  assert.equal(listeners.length, 1, 'replaced, not doubled, on a user switch');
});

test('hiding the badges in the settings panel takes effect on the cards without a reload', async t => {
  const h = setup(t, { html: cardsHtml(['Movie']), config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false }, responses: path => stampAnswer(path, { [id(0)]: 'fourK' }) });
  await h.show();
  assert.ok(h.document.querySelector('.je-arr-badge-stamp'));
  h.JE.currentSettings.acquisitionBadges = false;
  h.cards.reset();
  assert.equal(h.document.querySelector('.je-arr-badge'), null);
  h.observers[0].fn([{ isIntersecting: true, target: h.document.querySelector('.card') }]);
  await h.cards.flush();
  assert.equal(h.stampCalls().length, 1, 'no more stamp reads');

  // Not started (hidden at load), then shown: the surface starts.
  const late = setup(t, { html: cardsHtml(['Movie']), config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false }, settings: { acquisitionBadges: false }, responses: path => stampAnswer(path, { [id(0)]: 'new' }) });
  late.JE.initializeArrStatus();
  assert.equal(late.observers.length, 0);
  late.JE.currentSettings.acquisitionBadges = null;
  late.cards.reset();
  assert.equal(late.observers.length, 1);
});

/** deepEqual across the jsdom realm (its arrays are not this realm's). */
function same(actual, expected, message) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}
