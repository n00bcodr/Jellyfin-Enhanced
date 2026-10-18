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
  same(await h.S.fetchStamps([id(1), 'je-synthetic', id(2)]), { items: [{ itemId: id(1), stamp: 'new' }], since: null });
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
    same(h.cards.cache.get(id(0)), { status: { itemId: id(0), ...statuses[id(0)] }, stamp: null, keys: [], at: h.cards.cache.get(id(0)).at });
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
function same(actual, expected, message = '') {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}

for (const action of ['hide', 'user switch', 'reset']) {
  test(`a deferred stamps response cannot cache or paint after ${action}`, async t => {
    const held = deferred();
    const h = setup(t, {
      html: cardsHtml(['Movie']),
      config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false },
      responses: () => held.promise
    });
    const shown = h.show();
    await nextTurn();
    if (action === 'hide') h.JE.currentSettings.acquisitionBadges = false;
    if (action === 'user switch') h.userChange.forEach(fn => fn());
    else h.cards.reset();
    held.resolve({ items: [{ itemId: id(0), stamp: 'new' }] });
    await shown;
    assert.equal(h.cards.cache.size, 0, 'obsolete generation must not be cached');
    assert.equal(h.document.querySelector('.je-arr-badge'), null, 'obsolete generation must not paint');
  });
}

test('a watch invalidation during a held stamps read survives another flush and refetches on completion', async t => {
  const held = deferred();
  let reads = 0;
  const h = setup(t, {
    html: cardsHtml(['Movie']),
    config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false },
    responses: () => ++reads === 1 ? held.promise : { items: [] }
  });
  const shown = h.show();
  await nextTurn();
  h.cards.onUserData({ UserDataList: [{ ItemId: id(0), Played: true }] });
  await h.cards.flush();
  held.resolve({ items: [{ itemId: id(0), stamp: 'new' }] });
  await shown;
  assert.equal(h.document.querySelector('.je-arr-badge'), null, 'invalidated answer cannot paint while the refetch waits');
  await new Promise(resolve => h.window.setTimeout(resolve, 400));
  assert.equal(reads, 2, 'queued invalidation is automatically fetched after completion');
  assert.equal(h.cards.cache.get(id(0))?.stamp ?? null, null);
});

test('partial playback refreshes season and series cards including a parent whose first stamps read is held', async t => {
  for (const heldFirst of [false, true]) {
    const held = deferred();
    let reads = 0;
    const h = setup(t, {
      html: cardsHtml(['Season', 'Series', 'Movie']),
      config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false },
      responses: path => ++reads === 1
        ? held.promise
        : stampAnswer(path, { [id(2)]: 'new' })
    });
    const shown = h.show();
    await nextTurn();
    if (!heldFirst) {
      held.resolve({ items: [0, 1, 2].map(i => ({ itemId: id(i), stamp: 'new' })) });
      await shown;
    }
    h.cards.onUserData({ UserDataList: [{ ItemId: id(99), Played: false, LastPlayedDate: '2026-10-18T01:00:00Z' }] });
    if (heldFirst) {
      held.resolve({ items: [0, 1, 2].map(i => ({ itemId: id(i), stamp: 'new' })) });
      await shown;
    }
    await h.cards.flush();
    same(idsOf(h.stampCalls().at(-1).path).sort(), [id(0), id(1)]);
    const cards = h.document.querySelectorAll('.card');
    assert.equal(cards[0].querySelector('.je-arr-badge'), null);
    assert.equal(cards[1].querySelector('.je-arr-badge'), null);
    assert.ok(cards[2].querySelector('.je-arr-badge'), 'unrelated movie stays painted');
  }
});


// Review round 2: transport effects obey the same session/surface boundary as paints.
for (const route of ['stamps', 'status']) {
  for (const change of ['user', 'reset']) test(`late ${route} 403 after ${change} cannot disable the current surface`, async t => {
    const held = deferred();
    let reads = 0;
    const h = setup(t, { config: { ArrAcquisitionBadgesEnabled: true }, responses: () => ++reads === 1 ? held.promise : { items: [] } });
    const read = () => route === 'stamps' ? h.S.fetchStamps([id(1)]) : h.S.fetchBatch([id(1)], []);
    const pending = read();
    await nextTurn();
    if (change === 'user') h.userChange.forEach(fn => fn());
    else h.cards.reset();
    held.resolve(Object.assign(new Error('HTTP 403'), { status: 403 }));
    assert.equal(await pending, null);
    assert.equal(route === 'stamps' ? h.S.stampsEnabled() : h.S.enabled(), true);
    assert.ok(await read(), 'the current surface still fetches');
    assert.equal(reads, 2);
  });
}

test('an obsolete successful transport response is discarded before returning to consumers', async t => {
  const held = deferred();
  const h = setup(t, { config: { ArrAcquisitionBadgesEnabled: true }, responses: () => held.promise });
  const pending = h.S.fetchStamps([id(1)]);
  await nextTurn();
  h.userChange.forEach(fn => fn());
  held.resolve({ items: [{ itemId: id(1), stamp: 'new' }] });
  assert.equal(await pending, null);
});

test('acquisition-only cards follow title keys and the pre-read feed cursor, including unstamped cards', async t => {
  let upgraded = false;
  const subscriptions = [];
  const h = setup(t, {
    html: cardsHtml(['Movie', 'Movie']),
    config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false },
    responses: path => ({
      ...stampAnswer(path, upgraded ? { [id(0)]: 'upgraded', [id(1)]: 'new' } : { [id(0)]: 'new' }),
      subscriptions: [0, 1].map(i => ({ itemId: id(i), keys: [`movie:tmdb:${i + 1}`] }))
    })
  });
  h.JE.arr = {
    live: { position: () => ({ epoch: 'feed', cursor: 7 }) },
    onStatusChange: (keys, callback, options) => { subscriptions.push({ keys, callback, options }); return () => {}; }
  };
  await h.show();
  assert.equal(h.statusCalls().length, 0);
  assert.equal(subscriptions.length, 1, 'stamps-only cards have their own subscription');
  same(subscriptions[0].keys, ['movie:tmdb:1', 'movie:tmdb:2']);
  same(subscriptions[0].options, { since: { epoch: 'feed', cursor: 7 } });
  upgraded = true;
  subscriptions[0].callback(['movie:tmdb:1', 'movie:tmdb:2']);
  await h.cards.flush();
  assert.ok(h.document.querySelector(`[data-id="${id(0)}"] .je-arr-tone-upgraded`));
  assert.ok(h.document.querySelector(`[data-id="${id(1)}"] .je-arr-tone-new`));
});


test('switching people while the feed primes cancels the old read before transport', async t => {
  const held = deferred();
  const h = setup(t, { config: { ArrAcquisitionBadgesEnabled: true } });
  h.JE.arr = { live: { position: () => null, prime: () => held.promise } };
  const stamps = h.S.fetchStamps([id(1)]);
  const status = h.S.fetchBatch([id(1)], []);
  await nextTurn();
  h.userChange.forEach(fn => fn());
  held.resolve({ epoch: 'old', cursor: 8 });
  assert.equal(await stamps, null);
  assert.equal(await status, null);
  assert.equal(h.calls.length, 0);
});

test('a reset starts an independent HTTP read even while the core API holds the previous generation', async t => {
  const held = [deferred(), deferred()];
  let reads = 0;
  const h = setup(t, { html: cardsHtml(['Movie']), config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false } });
  h.window.fetch = async () => {
    const answer = await held[reads++].promise;
    return new Response(JSON.stringify({ items: [{ itemId: id(0), stamp: answer }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  h.load('core/api-client.js');
  const old = h.show();
  await nextTurn();
  h.cards.reset();
  const fresh = h.show();
  await nextTurn();
  const started = reads;
  held[0].resolve('new');
  held[1].resolve('upgraded');
  await Promise.all([old, fresh]);
  assert.equal(started, 2, 'the new surface must not join the old HTTP response');
  assert.equal(h.cards.cache.get(id(0)).stamp, 'upgraded');
});

// Review round 3: use the actual panel listener and card surface across delayed failures.
for (const hiding of [true, false]) test(`a delayed failed ${hiding ? 'Hide' : 'Show'} restores rendering, observer and watch listener`, async t => {
  const saved = deferred();
  const listeners = new Set();
  const h = setup(t, {
    html: cardsHtml(['Movie']) + '<select id="acquisitionBadgesSelect"><option value="">Show</option><option value="off">Hide</option></select>',
    config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false },
    settings: { acquisitionBadges: hiding ? null : false },
    apiClient: { subscribe: (_name, fn) => { listeners.add(fn); return () => listeners.delete(fn); } },
    responses: path => stampAnswer(path, { [id(0)]: 'new' })
  });
  h.JE.userConfig = { settings: { ...h.JE.currentSettings } };
  const preset = { name: 'p', previewText: 'Aa', size: 1, family: 'sans-serif', bgColor: '#000', textColor: '#fff' };
  Object.assign(h.JE, { escapeHtml: value => String(value ?? ''), icon: () => '', IconName: new Proxy({}, { get: (_, k) => String(k) }),
    icons: { wrapEmoji: s => s }, state: { activeShortcuts: {} }, pluginVersion: '0.0.0',
    fontSizePresets: [preset, preset, preset, preset], fontFamilyPresets: [preset], subtitlePresets: [preset], subtitleTextEffectPresets: [preset],
    decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alpha: 255, alphaValue: 255 }), getSubtitleTextShadow: () => 'none' });
  h.JE.pluginConfig.Shortcuts = [];
  h.JE.userConfig.shortcuts = { Shortcuts: [] };
  h.load('enhanced/settingspanel/ui-panel-template.js');
  h.document.body.innerHTML = cardsHtml(['Movie']) + h.JE.internals.enhancedUi.buildPanelHtml({ presetBoxBackground: '#111', detailsBackground: '#222', toggleAccentColor: '#333' });
  h.JE.saveUserSettings = () => saved.promise;
  h.JE.toast = () => assert.fail('a failed save must not claim success');
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  h.JE.internals.enhancedUi.wireSettingsListeners({ createToast() {}, resetAutoCloseTimer() {} });
  await h.show();
  const select = h.document.getElementById('acquisitionBadgesSelect');
  select.value = hiding ? 'off' : '';
  select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await nextTurn();
  await h.show();
  await h.cards.flush(); // give the optimistic surface time to detach/observe before the failure
  saved.reject(new Error('blocked save'));
  await new Promise(resolve => h.window.setTimeout(resolve, 20));
  for (const io of h.observers) io.fn([...io.observed].map(target => ({ isIntersecting: true, target })));
  await h.cards.flush();
  assert.equal(h.JE.currentSettings.acquisitionBadges, hiding ? null : false);
  assert.equal(!!h.document.querySelector('.je-arr-tone-new'), hiding);
  assert.equal(listeners.size, hiding ? 1 : 0, 'watch listener follows restored preference');
  h.document.body.insertAdjacentHTML('beforeend', cardsHtml(['Movie', 'Movie']));
  h.cards.scan();
  assert.equal(h.observers.some(io => io.observed.size > 0), hiding, 'observer follows restored preference');
});

// Review round 4: the real save queue must roll back to persisted, not optimistic, state.
for (const initial of [null, false]) for (const outcomes of [[false, false], [false, true], [true, false]]) {
  test(`queued badge toggles from ${initial} with save outcomes ${outcomes}`, async t => {
    const saves = [deferred(), deferred()];
    const posted = [];
    let persisted = initial;
    const h = setup(t, {
      html: cardsHtml(['Movie']),
      config: { ArrAcquisitionBadgesEnabled: true, ArrStatusPosterBadges: false },
      settings: { acquisitionBadges: initial },
      responses: path => stampAnswer(path, { [id(0)]: 'new' }),
      apiClient: { ajax: async request => {
        const n = posted.length;
        posted.push(JSON.parse(request.data).acquisitionBadges);
        await saves[n].promise;
        persisted = posted[n];
      } }
    });
    h.JE.userConfig = { settings: { ...h.JE.currentSettings }, shortcuts: { Shortcuts: [] } };
    const preset = { name: 'p', previewText: 'Aa', size: 1, family: 'sans-serif', bgColor: '#000', textColor: '#fff' };
    Object.assign(h.JE, { escapeHtml: value => String(value ?? ''), icon: () => '', IconName: new Proxy({}, { get: (_, k) => String(k) }),
      icons: { wrapEmoji: s => s }, state: { activeShortcuts: {} }, pluginVersion: '0.0.0',
      fontSizePresets: [preset, preset, preset, preset], fontFamilyPresets: [preset], subtitlePresets: [preset], subtitleTextEffectPresets: [preset],
      decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alpha: 255, alphaValue: 255 }), getSubtitleTextShadow: () => 'none', toast() {} });
    h.JE.pluginConfig.Shortcuts = [];
    h.load('enhanced/config.js');
    h.load('enhanced/settingspanel/ui-panel-template.js');
    h.document.body.innerHTML = cardsHtml(['Movie']) + h.JE.internals.enhancedUi.buildPanelHtml({ presetBoxBackground: '#111', detailsBackground: '#222', toggleAccentColor: '#333' });
    h.load('enhanced/settingspanel/ui-panel-settings.js');
    h.JE.internals.enhancedUi.wireSettingsListeners({ createToast() {}, resetAutoCloseTimer() {} });
    await h.show();
    const select = h.document.getElementById('acquisitionBadgesSelect');
    const change = value => { select.value = value === false ? 'off' : ''; select.dispatchEvent(new h.window.Event('change', { bubbles: true })); };
    change(initial === false ? null : false);
    change(initial);
    await nextTurn();
    assert.equal(posted.length, 1, 'second snapshot waits for the real save queue');
    for (let n = 0; n < 2; n++) {
      if (outcomes[n]) saves[n].resolve(); else saves[n].reject(new Error('blocked save'));
      await nextTurn();
    }
    await h.show();
    assert.equal(posted.length, 2);
    assert.equal(h.JE.currentSettings.acquisitionBadges, persisted);
    assert.equal(h.JE.userConfig.settings.acquisitionBadges, persisted);
    assert.equal(select.value, persisted === false ? 'off' : '');
    assert.equal(!!h.document.querySelector('.je-arr-tone-new'), persisted !== false);
  });
}
