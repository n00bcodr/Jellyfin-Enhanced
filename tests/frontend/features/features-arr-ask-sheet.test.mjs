// Requests & downloads, phase 3: the request sheet (movie one tap vs sheet, series cards and costs,
// over quota, 4K, retry-safe asks, focus), smart actions on details pages, collection gaps and the
// mountable request controls — the real modules against a fake request API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, jsRoot, jsonResponse, deferred } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = [
  'arr/status/status-core.js', 'arr/status/status-episodes.js', 'arr/status/status-details.js',
  'arr/ask/ask-core.js', 'arr/ask/ask-episodes.js', 'arr/ask/ask-sheet-styles.js', 'arr/ask/ask-sheet.js',
  'arr/ask/ask-actions.js', 'arr/ask/ask-collection.js', 'arr/ask/ask-styles.js'
];
const ARR_WORDS = /sonarr|radarr|instance|profile|root folder|tags?\b|quality|path/i;

/** JE.t as the real one behaves: the English string with {name} parameters filled in. */
function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

const MEMBER = { role: 'member', canRequest: true, canApprove: false, asksFirst: false, can4kMovies: false, can4kSeries: false, backend: 'je', contact: 'Dad', freeEpisodes: 5 };
const KID = { ...MEMBER, role: 'kid', asksFirst: true };
const WATCHER = { ...MEMBER, role: 'watcher', canRequest: false };
const inDays = days => new Date(Date.now() + days * 86400000).toISOString();

/**
 * A harness with the request API faked: `me`, `quota` (per media type) and `answer(input, n)` for
 * POST acquire/requests; `routes(method, path)` may answer anything else.
 */
function setup(t, { me = MEMBER, quota = { used: 2, limit: 7, remaining: 5, nextSlotAt: null, usedGb: 0, available: true }, answer, routes, html = '', hash = '#/home', status, item, config = {} } = {}) {
  const posts = [];
  const searches = [];
  const gets = [];
  const toasts = [];
  const statusCalls = [];
  const state = { me, quota, answer: answer || (() => ({ status: 201, body: { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded', message: 'Asked!', requestId: 'a'.repeat(32) } })) };
  const h = createHarness({
    html,
    url: `http://jellyfin.test/web/index.html${hash}`,
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/JellyfinEnhanced/, '') + u.search;
      const method = init.method || 'GET';
      if (method === 'POST' && path === '/acquire/requests/search') {
        // A family Search: the server says to ask instead unless a test's route answers it.
        const body = JSON.parse(init.body);
        searches.push({ path, body });
        const custom = routes ? await routes(method, path, body) : null;
        if (custom) return jsonResponse(custom.body, custom.status ?? 200);
        return jsonResponse({ outcome: 'skipped', reason: 'not_requested', certainty: 'Rejected', message: 'Nothing was asked for here yet.' }, 200);
      }
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push({ path, body });
        if (path === '/acquire/requests') {
          const a = await state.answer(body.input, posts.length, body);
          return jsonResponse(a.body, a.status);
        }
      } else {
        gets.push(path);
      }
      const custom = routes ? await routes(method, path) : null;
      if (custom) return jsonResponse(custom.body, custom.status ?? 200);
      if (path === '/acquire/requests/me') return jsonResponse({ outcome: 'accepted', reason: 'me', me: state.me });
      if (path.startsWith('/acquire/requests/quota')) {
        const q = typeof state.quota === 'function' ? state.quota(path) : state.quota;
        return jsonResponse({ outcome: 'accepted', reason: 'quota', quota: q });
      }
      return jsonResponse({ outcome: 'denied', reason: 'not_found' }, 404);
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsEnabled: true, ...config },
      t: translate,
      toast: (text) => toasts.push(text),
      escapeHtml: (s) => s,
      helpers: {
        debounce: fn => fn,
        addCSS: (id, css) => { const s = h.document.createElement('style'); s.id = id; s.textContent = css; h.document.head.appendChild(s); },
        getItemCached: async (id) => (typeof item === 'function' ? item(id) : item) || null
      },
      core: {
        api: {
          plugin: async (path) => {
            statusCalls.push(path);
            return typeof status === 'function' ? status(path) : status || null;
          }
        },
        navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      session: { epoch: 0, getEpoch() { return this.epoch; }, isCurrent: () => true, onUserChange: () => {} },
      internals: {
        arrNotify: {
          attachModal: (mount, s, key) => {
            const b = h.document.createElement('button');
            b.className = 'je-notify-follow';
            b.dataset.key = key;
            b.textContent = 'Notify me';
            mount.appendChild(b);
          }
        }
      }
    }
  });
  t.after(() => h.close());
  for (const m of MODULES) h.load(m);
  return { ...h, get NATIVE() { return h.NATIVE; }, posts, searches, gets, toasts, statusCalls, state, Sheet: h.JE.arrAskSheet };
}

async function settle(n = 12) {
  for (let i = 0; i < n; i++) await nextTurn();
}

const sheetEl = h => h.document.querySelector('.je-sheet');
const primary = h => h.document.querySelector('.je-sheet-primary');
const card = (h, id) => h.document.querySelector(`.je-sheet-card[data-choice="${id}"]`);
const costText = (h, id) => card(h, id).querySelector('.je-sheet-card-cost').textContent;
// The viewer's click: a trusted event, as the browser dispatches it (native owners are minted only from those).
const click = (h, node) => h.trusted(node, new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const key = (h, k, shift = false) => (h.document.activeElement || h.document.body).dispatchEvent(new h.window.KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));

const SERIES = {
  key: 'tv:tvdb:393199', kind: 'series', name: 'Andor', year: 2022, poster: '/andor.jpg',
  seasons: [{ season: 1, episodes: 12, have: 12 }, { season: 2, episodes: 12, have: 0 }, { season: 3, episodes: 6, have: 0 }],
  latestSeason: 3, nextSeason: 4
};
const MOVIE = { key: 'movie:tmdb:1084242', kind: 'movie', name: 'Toy Story 5', year: 2026, poster: '/toy.jpg' };

// ------------------------------------------------------------------ movies: one tap vs the sheet

test('a movie is asked for with one tap and a toast when nothing needs the sheet', async t => {
  const h = setup(t);
  const result = await h.Sheet.openOrAsk(MOVIE, { operation: h.NATIVE });
  assert.equal(result.state, 'asked');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].body.input.key, MOVIE.key);
  assert.equal(h.posts[0].body.input.scope, 'movie');
  assert.equal(h.posts[0].body.input.variant, 'standard');
  assert.equal(sheetEl(h), null);
  assert.deepEqual(h.toasts, ["Asked! We'll let you know."]);
});

test('a second tap on a movie while the first is out is the same single request', async t => {
  const gate = deferred();
  const h = setup(t, { answer: async () => { await gate.promise; return { status: 201, body: { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded' } }; } });
  const first = h.Sheet.openOrAsk(MOVIE, { operation: h.NATIVE });
  const second = h.Sheet.openOrAsk(MOVIE, { operation: h.NATIVE });
  await settle();
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(h.posts.length, 1);
  assert.equal(a, b);
  assert.equal(h.toasts.length, 1);
});

for (const [name, me, quota, expectToggle] of [
  ['the quota is nearly used', MEMBER, { used: 6, limit: 7, remaining: 1, available: true }, false],
  ["the caller's asks wait for an OK", KID, { used: 0, limit: 7, remaining: 7, available: true }, false],
  ['the caller may choose 4K', { ...MEMBER, can4kMovies: true }, null, true]
]) {
  test(`a movie opens the sheet when ${name}`, async t => {
    const h = setup(t, { me, quota });
    const pending = h.Sheet.openOrAsk(MOVIE, { operation: h.NATIVE });
    await settle();
    assert.ok(sheetEl(h), 'sheet shown');
    assert.equal(h.posts.length, 0, 'nothing asked before the sheet is confirmed');
    assert.equal(!!h.document.querySelector('.je-sheet-variant'), expectToggle);
    h.Sheet.close();
    assert.equal(await pending, null);
  });
}

test('an unknown allowance (Seerr placeholder) does not force the sheet', async t => {
  const h = setup(t, { quota: { used: 0, limit: null, remaining: null, available: false } });
  const result = await h.Sheet.openOrAsk(MOVIE, { operation: h.NATIVE });
  assert.equal(result.state, 'asked');
  assert.equal(sheetEl(h), null);
});

test('a Watcher is told plainly and nothing is asked', async t => {
  const h = setup(t, { me: WATCHER });
  assert.equal(await h.Sheet.openOrAsk(MOVIE, { operation: h.NATIVE }), null);
  assert.equal(await h.Sheet.open(SERIES, { operation: h.NATIVE }), null);
  assert.equal(h.posts.length, 0);
  assert.deepEqual(h.toasts, ["You can't ask for this one.", "You can't ask for this one."]);
});

// ------------------------------------------------------------------ series cards and costs

test('series cards show what each costs from the quota projection', async t => {
  const h = setup(t, { quota: { used: 3, limit: 7, remaining: 4, available: true } });
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  assert.equal(h.document.querySelector('.je-sheet-title').textContent, 'Get Andor');
  assert.equal(h.document.querySelector('.je-sheet-facts').textContent, '3 seasons · 30 episodes');
  assert.deepEqual([...h.document.querySelectorAll('.je-sheet-card')].map(c => c.dataset.choice), ['everything', 'latest', 'next', 'pick', 'episodes', 'future']);
  assert.equal(card(h, 'everything').querySelector('.je-sheet-card-label').textContent, 'Everything (2 seasons)');
  assert.equal(costText(h, 'everything'), 'Uses 2 of your 4 this week');
  assert.equal(costText(h, 'latest'), 'Uses 1 of your 4 this week');
  assert.equal(costText(h, 'next'), 'Uses 1 of your 4 this week');
  assert.equal(costText(h, 'future'), 'Uses 1 of your 4 now, then 1 for each new season');
  assert.equal(card(h, 'everything').getAttribute('aria-pressed'), 'true');
  assert.equal(h.document.activeElement, card(h, 'everything'));
  assert.match(primary(h).textContent, /Request/);
  assert.equal(h.document.querySelector('img.je-sheet-poster').src, 'https://image.tmdb.org/t/p/w154/andor.jpg');

  click(h, primary(h));
  const result = await pending;
  assert.equal(result.state, 'asked');
  assert.equal(h.posts.length, 1);
  const input = h.posts[0].body.input;
  assert.deepEqual({ key: input.key, scope: input.scope, seasons: [...input.seasons], variant: input.variant }, { key: 'tv:tvdb:393199', scope: 'seasons', seasons: [2, 3], variant: 'standard' });
  assert.equal(sheetEl(h), null, 'closed after the ask');
  assert.deepEqual(h.toasts, ["Asked! We'll let you know."]);
});

test('one episode reads "1 episode", in the header and the season picker', async t => {
  const h = setup(t);
  h.Sheet.open({ key: 'tv:tvdb:1', kind: 'series', name: 'A Short', seasons: [{ season: 1, episodes: 1, have: 0 }], latestSeason: 1 }, { operation: h.NATIVE });
  await settle();
  assert.equal(h.document.querySelector('.je-sheet-facts').textContent, '1 season · 1 episode');
  h.Sheet.close();
  h.Sheet.open({ key: 'tv:tvdb:2', kind: 'series', name: 'Two Shorts', seasons: [{ season: 1, episodes: 1, have: 0 }, { season: 2, episodes: 0, have: 0 }], latestSeason: 2 }, { operation: h.NATIVE });
  await settle();
  assert.equal(h.document.querySelector('.je-sheet-facts').textContent, '2 seasons · 1 episode');
  h.Sheet.close();
  h.Sheet.open({ key: 'tv:tvdb:3', kind: 'series', name: 'Pilot', seasons: [{ season: 1, episodes: 1, have: 0 }, { season: 2, episodes: 3, have: 0 }], latestSeason: 2 }, { operation: h.NATIVE });
  await settle();
  click(h, card(h, 'pick'));
  assert.deepEqual([...h.document.querySelectorAll('.je-sheet-pick .je-sheet-check-facts')].map(x => x.textContent), ['1 episode', '3 episodes']);
  h.Sheet.close();
});

test('next season, future and the pickers send the scope the card names', async t => {
  const h = setup(t, { quota: { used: 0, limit: null, remaining: null, available: true } });
  const asks = [];
  h.state.answer = (input) => { asks.push(input); return { status: 201, body: { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded' } }; };
  for (const [choice, expected] of [['next', { scope: 'next_season', seasons: [4] }], ['future', { scope: 'future', seasons: [3] }], ['latest', { scope: 'seasons', seasons: [3] }]]) {
    const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
    await settle();
    assert.equal(costText(h, choice), '', 'no cost line for an unlimited allowance');
    click(h, card(h, choice));
    click(h, primary(h));
    await pending;
    const input = asks[asks.length - 1];
    assert.deepEqual({ scope: input.scope, seasons: [...input.seasons] }, expected, choice);
  }

  // Pick seasons: nothing picked → a hint, no request; complete seasons can't be picked.
  let pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  click(h, card(h, 'pick'));
  const panel = h.document.querySelector('.je-sheet-pick');
  assert.equal(panel.hidden, false);
  const boxes = [...panel.querySelectorAll('input[type=checkbox]')];
  assert.deepEqual(boxes.map(b => b.disabled), [true, false, false]);
  assert.match(panel.textContent, /All here/);
  const before = asks.length;
  click(h, primary(h));
  await settle();
  assert.equal(asks.length, before);
  assert.equal(h.document.querySelector('.je-sheet-message').textContent, 'Choose at least one first.');
  boxes[2].checked = true;
  boxes[2].dispatchEvent(new h.window.Event('change', { bubbles: true }));
  click(h, primary(h));
  await pending;
  assert.deepEqual([...asks[asks.length - 1].seasons], [3]);

  // Pick episodes: six episodes of season 2 → episodes scope.
  pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  click(h, card(h, 'episodes'));
  click(h, h.document.querySelector('.je-sheet-episode-season[data-season="2"]'));
  for (const n of [1, 2, 3, 4, 5, 6]) click(h, h.document.querySelector(`.je-sheet-episode[data-episode="${n}"]`));
  assert.equal(h.document.querySelector('.je-sheet-episode[data-episode="3"]').getAttribute('aria-pressed'), 'true');
  click(h, primary(h));
  await pending;
  const eps = asks[asks.length - 1];
  assert.equal(eps.scope, 'episodes');
  assert.deepEqual(eps.episodes.map(e => `${e.season}x${e.episode}`), ['2x1', '2x2', '2x3', '2x4', '2x5', '2x6']);
});

test('episode costs: the free ones cost nothing, then one per five', async t => {
  const h = setup(t, { quota: { used: 0, limit: 7, remaining: 7, available: true } });
  const I = h.JE.internals.arrAskSheet;
  assert.equal(I.episodeCost(5, 5), 0);
  assert.equal(I.episodeCost(6, 5), 1);
  assert.equal(I.episodeCost(10, 5), 1);
  assert.equal(I.episodeCost(11, 5), 2);
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  click(h, card(h, 'episodes'));
  click(h, h.document.querySelector('.je-sheet-episode[data-episode="1"]'));
  assert.equal(costText(h, 'episodes'), 'Free (up to 5 episodes a week)');
  for (const n of [2, 3, 4, 5, 6]) click(h, h.document.querySelector(`.je-sheet-episode[data-episode="${n}"]`));
  assert.equal(costText(h, 'episodes'), 'Uses 1 of your 7 this week');
  h.Sheet.close();
  assert.equal(await pending, null);
});

// ------------------------------------------------------------------ over quota, Seerr, 4K

test('over quota in JE mode: the amber note and "Send to Dad for an OK", recorded as waiting', async t => {
  const h = setup(t, {
    quota: { used: 7, limit: 7, remaining: 0, nextSlotAt: inDays(3), available: true },
    answer: () => ({ status: 201, body: { outcome: 'accepted', reason: 'over_quota', certainty: 'Succeeded', requestId: 'b'.repeat(32) } })
  });
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  const note = h.document.querySelector('.je-sheet-note');
  assert.equal(note.hidden, false);
  assert.ok(note.classList.contains('je-sheet-note-attention'));
  assert.match(note.textContent, /^hourglass_emptyYou've used this week's 7 requests \(next frees up .+\)$/);
  assert.equal(primary(h).textContent, 'sendSend to Dad for an OK');
  assert.match(costText(h, 'everything'), /Needs Dad's OK \(none left this week\)/);
  click(h, primary(h));
  const result = await pending;
  assert.equal(result.state, 'waiting');
  assert.deepEqual(h.toasts, ["Sent to Dad for an OK (you've used this week's requests)."]);
});

test('over quota in Seerr mode: the honest quota words and no Send', async t => {
  const h = setup(t, { me: { ...MEMBER, backend: 'seerr' }, quota: { used: 7, limit: 7, remaining: 0, nextSlotAt: inDays(2), available: true } });
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  assert.equal(primary(h).hidden, true);
  assert.match(h.document.querySelector('.je-sheet-note').textContent, /You've used this week's requests · next one frees up /);
  assert.equal(h.document.querySelector('.je-sheet-secondary').textContent, 'Close');
  click(h, h.document.querySelector('.je-sheet-secondary'));
  assert.equal(await pending, null);
  assert.equal(h.posts.length, 0);
});

test('a 429 from the server keeps the sheet open with the quota words', async t => {
  const h = setup(t, {
    quota: { used: 0, limit: null, remaining: null, available: false },
    answer: () => ({ status: 429, body: { outcome: 'quota_exceeded', reason: 'quota_exceeded', certainty: 'Rejected' } })
  });
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  click(h, primary(h));
  await settle(20);
  assert.ok(sheetEl(h), 'still open');
  assert.equal(h.document.querySelector('.je-sheet-message').textContent, "You've used this week's requests.");
  h.Sheet.close();
  assert.equal(await pending, null);
});

test('the Standard / 4K toggle appears only for people who may ask for 4K of that kind', async t => {
  const h = setup(t);
  let pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  assert.equal(h.document.querySelector('.je-sheet-variant'), null);
  h.Sheet.close();
  await pending;

  h.state.me = { ...MEMBER, can4kSeries: true };
  h.JE.arrAsk.me(true);
  await settle();
  pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  const options = [...h.document.querySelectorAll('.je-sheet-variant-option')];
  assert.deepEqual(options.map(o => o.textContent), ['Standard', '4K']);
  assert.equal(options[0].getAttribute('aria-pressed'), 'true');
  click(h, options[1]);
  assert.equal(options[1].getAttribute('aria-pressed'), 'true');
  click(h, primary(h));
  await pending;
  assert.equal(h.posts[0].body.input.variant, '4k');
});

// ------------------------------------------------------------------ retry safety and focus

test('a double tap on the sheet sends one request; a retry after a failure reuses its id', async t => {
  const gate = deferred();
  let n = 0;
  const h = setup(t, {
    answer: async () => {
      n++;
      if (n === 1) { await gate.promise; return { status: 503, body: { outcome: 'unavailable', reason: 'database_unavailable', certainty: 'Failed' } }; }
      return { status: 201, body: { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded' } };
    }
  });
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  click(h, primary(h));
  click(h, primary(h));
  await settle();
  assert.equal(primary(h).disabled, true);
  assert.equal(primary(h).textContent, 'Asking…');
  gate.resolve();
  await settle(20);
  assert.equal(h.posts.length, 1, 'one request for the double tap');
  assert.equal(h.document.querySelector('.je-sheet-message').textContent, "Couldn't ask right now. Try again later.");
  click(h, primary(h));
  await pending;
  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[1].body.clientRequestId, h.posts[0].body.clientRequestId, 'the retry is the same ask');
});

test('Tab stays inside the sheet, Escape closes it and focus returns to the opener', async t => {
  const h = setup(t, { html: '<button id="opener">More…</button>' });
  const opener = h.document.getElementById('opener');
  opener.focus();
  const pending = h.Sheet.open(SERIES, { opener , operation: h.NATIVE });
  await settle();
  const sheet = sheetEl(h);
  assert.equal(sheet.getAttribute('role'), 'dialog');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  assert.equal(h.document.getElementById(sheet.getAttribute('aria-labelledby')).textContent, 'Get Andor');
  const focusables = [...sheet.querySelectorAll('button, input')].filter(n => !n.disabled && !n.closest('[hidden]') && !n.hidden);
  const last = focusables[focusables.length - 1];
  last.focus();
  key(h, 'Tab');
  assert.equal(h.document.activeElement, focusables[0], 'Tab from the last goes to the first');
  key(h, 'Tab', true);
  assert.equal(h.document.activeElement, last, 'Shift+Tab from the first goes to the last');
  key(h, 'Escape');
  assert.equal(await pending, null);
  assert.equal(sheetEl(h), null);
  assert.equal(h.document.activeElement, opener);
});

test('on TV the sheet is a full-screen panel and Back closes it', async t => {
  const h = setup(t);
  h.document.documentElement.classList.add('layout-tv');
  const pending = h.Sheet.open(MOVIE, { operation: h.NATIVE });
  await settle();
  assert.ok(h.document.querySelector('.je-sheet-backdrop').classList.contains('je-sheet-tv'));
  // jellyfin-web's D-pad navigation stays inside a focus container: the arrows never reach the page behind.
  assert.ok(sheetEl(h).classList.contains('focuscontainer'));
  key(h, 'Backspace');
  assert.equal(await pending, null);
});

// ------------------------------------------------------------------ family words

const OUTCOMES = [
  [201, { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded' }, "Asked! We'll let you know.", true],
  [201, { outcome: 'accepted', reason: 'awaiting_approval', certainty: 'Succeeded' }, 'Asked! Dad will take a look.', true],
  [200, { outcome: 'merged', reason: 'looking', certainty: 'Succeeded' }, "Someone in your household already asked, we'll tell you both.", true],
  [200, { outcome: 'already_requested', reason: 'looking', certainty: 'Succeeded' }, "Someone in your household already asked, we'll tell you both.", true],
  [200, { outcome: 'nothing_to_request', reason: 'nothing_to_request', certainty: 'Succeeded' }, "That's already here or on its way.", true],
  [202, { outcome: 'maybe_sent', reason: 'maybe_sent', certainty: 'Unknown' }, "Asked! We'll confirm shortly.", true],
  [429, { outcome: 'quota_exceeded', reason: 'quota_exceeded', certainty: 'Rejected' }, "You've used this week's requests.", false],
  [403, { outcome: 'blocked', reason: 'parental_blocked', certainty: 'Rejected' }, "This one can't be asked for here.", false],
  [403, { outcome: 'blocked', reason: 'decline_cooldown', certainty: 'Rejected' }, 'Dad said no to this one recently. You can ask again later.', false],
  [403, { outcome: 'denied', reason: 'requests_create_required', certainty: 'Rejected' }, "You can't ask for this one.", false],
  [503, { outcome: 'unavailable', reason: 'database_unavailable', certainty: 'Failed' }, "Couldn't ask right now. Try again later.", false],
  [409, { outcome: 'denied', reason: 'idempotency_conflict', certainty: 'Rejected' }, 'That changed while you asked. Try again.', false]
];

test('every request outcome reads as honest family words, in the toast or in the sheet', async t => {
  const h = setup(t, { quota: { used: 0, limit: null, remaining: null, available: false } });
  for (const [status, body, words, closes] of OUTCOMES) {
    h.state.answer = () => ({ status, body });
    h.toasts.length = 0;
    const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
    await settle();
    click(h, primary(h));
    await settle(20);
    if (closes) {
      await pending;
      assert.deepEqual(h.toasts, [words], `${status} ${body.outcome}/${body.reason}`);
      assert.equal(sheetEl(h), null);
    } else {
      const sheet = sheetEl(h);
      assert.ok(sheet, `${status} ${body.reason} keeps the sheet open`);
      assert.equal(h.document.querySelector('.je-sheet-message').textContent, words, `${status} ${body.reason}`);
      assert.doesNotMatch(sheet.textContent, ARR_WORDS);
      h.Sheet.close();
      assert.equal(await pending, null);
    }
  }
});

// ------------------------------------------------------------------ kids and the mount API

test('kids: "Ask Dad" on the mounted controls, the sheet asks Dad, then "Waiting for OK"', async t => {
  const h = setup(t, {
    me: KID,
    html: '<div id="host"></div>',
    answer: () => ({ status: 201, body: { outcome: 'accepted', reason: 'awaiting_approval', certainty: 'Succeeded', requestId: 'c'.repeat(32) } })
  });
  const host = h.document.getElementById('host');
  const controls = h.Sheet.mount(host, MOVIE);
  await settle();
  const request = host.querySelector('.je-ask-mount-request');
  assert.equal(request.textContent, 'front_handAsk Dad');
  assert.ok(host.querySelector('.je-notify-follow'), 'Notify me next to it');
  click(h, request);
  await settle();
  assert.equal(h.document.querySelector('.je-sheet-title').textContent, 'Ask Dad for Toy Story 5');
  assert.equal(primary(h).textContent, 'front_handAsk Dad');
  assert.match(h.document.querySelector('.je-sheet-note').textContent, /Dad will take a look first\./);
  assert.doesNotMatch(sheetEl(h).textContent, ARR_WORDS);
  click(h, primary(h));
  await settle(30);
  assert.deepEqual(h.toasts, ['Asked! Dad will take a look.']);
  assert.equal(host.querySelector('.je-ask-mount-request'), null);
  assert.equal(host.querySelector('.je-arr-chip').textContent, 'Waiting for OK');
  controls.destroy();
  assert.equal(host.children.length, 0);
});

test('mount API: the current request state replaces Request; Watchers get Notify me only; off renders nothing', async t => {
  const h = setup(t, { html: '<div id="a"></div><div id="b"></div>' });
  const a = h.document.getElementById('a');
  const controls = h.Sheet.mount(a, SERIES);
  await settle();
  assert.equal(a.querySelector('.je-ask-mount-request').textContent, 'addRequest');
  controls.update({ key: SERIES.key, kind: 'series', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 42 } });
  assert.equal(a.querySelector('.je-ask-mount-request'), null);
  assert.equal(a.querySelector('.je-arr-chip').textContent, 'Downloading · 42%');
  controls.update({ key: SERIES.key, kind: 'series', stage: 'notHere', reason: { code: 'not_in_arr' } });
  assert.ok(a.querySelector('.je-ask-mount-request'));
  controls.destroy();

  h.state.me = WATCHER;
  h.JE.arrAsk.me(true);
  await settle();
  const b = h.document.getElementById('b');
  const watcher = h.Sheet.mount(b, MOVIE);
  await settle();
  assert.equal(b.querySelector('.je-ask-mount-request'), null);
  assert.ok(b.querySelector('.je-notify-follow'));
  watcher.destroy();

  h.JE.pluginConfig.ArrRequestsEnabled = false;
  const off = h.Sheet.mount(b, MOVIE);
  await settle();
  assert.equal(b.querySelector('.je-ask-mount').children.length, 0);
  off.destroy();
});

test('mount API on a page with its own status pill (state: false): after an ask the pill alone says where it stands', async t => {
  const h = setup(t, { html: '<div id="a"></div><div id="b"></div>' });
  const a = h.document.getElementById('a');
  const controls = h.Sheet.mount(a, MOVIE, { notify: false, state: false });
  await settle();
  const notHere = { key: MOVIE.key, kind: 'movie', stage: 'notHere', reason: { code: 'not_in_arr' } };
  controls.update(notHere);
  click(h, a.querySelector('.je-ask-mount-request'));
  await settle(20);
  same(h.posts[0].body.input, { key: MOVIE.key, scope: 'movie', variant: 'standard', seasons: [], episodes: [] });
  // Until the status catches up the mount says what happened (nothing else on the page does yet).
  assert.equal(a.querySelector('.je-arr-chip').textContent, 'Asked!');
  // The status (and so the page's pill) now says it: the mount adds no second chip.
  controls.update({ key: MOVIE.key, kind: 'movie', stage: 'looking', reason: { code: 'searching' } });
  assert.equal(a.querySelector('.je-arr-chip'), null);
  assert.equal(a.querySelector('.je-ask-mount-request'), null);
  controls.update({ key: MOVIE.key, kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 42 } });
  assert.equal(a.querySelector('.je-arr-chip'), null);
  controls.update(notHere);
  assert.ok(a.querySelector('.je-ask-mount-request'), 'Request is back when it can be asked for again');
  controls.destroy();

  // Without a pill on the page (the default) the mount keeps saying it.
  const b = h.document.getElementById('b');
  const own = h.Sheet.mount(b, MOVIE, { notify: false });
  await settle();
  own.update({ key: MOVIE.key, kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 42 } });
  assert.equal(b.querySelector('.je-arr-chip').textContent, 'Downloading · 42%');
  own.destroy();
});

test('mount API: a redraw keeps the keyboard focus on the control (or its stand-in)', async t => {
  const h = setup(t, { html: '<div id="a"></div>' });
  const a = h.document.getElementById('a');
  const controls = h.Sheet.mount(a, MOVIE);
  await settle();
  const notHere = { key: MOVIE.key, kind: 'movie', stage: 'notHere', reason: { code: 'not_in_arr' } };
  a.querySelector('.je-ask-mount-request').focus();
  // A re-read with the same state (the details surface forwards every read) redraws the row.
  controls.update(notHere);
  controls.update({ ...notHere });
  const request = a.querySelector('.je-ask-mount-request');
  assert.ok(request);
  assert.equal(h.document.activeElement, request);
  // Request gives way to a state chip: the focus goes to the mount's next control (Notify me), not the page.
  controls.update({ key: MOVIE.key, kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 42 } });
  assert.equal(a.querySelector('.je-ask-mount-request'), null);
  assert.ok(a.contains(h.document.activeElement) && h.document.activeElement.tagName === 'BUTTON');
  // Focus elsewhere on the page is never taken.
  const outside = h.document.createElement('button');
  h.document.body.appendChild(outside);
  outside.focus();
  controls.update(notHere);
  assert.equal(h.document.activeElement, outside);
  controls.destroy();
});

test('mount API: Request pressed from the keyboard or remote hands the focus to the state chip that replaces it', async t => {
  const h = setup(t, { html: '<div id="a"></div>' });
  const a = h.document.getElementById('a');
  // As the native details page mounts it: no Notify me (the page's details surface has its own).
  const controls = h.Sheet.mount(a, MOVIE, { notify: false });
  await settle();
  const request = a.querySelector('.je-ask-mount-request');
  // A browser drops the focus of a button as it becomes disabled (jsdom keeps it): do the same.
  const disabled = Object.getOwnPropertyDescriptor(h.window.HTMLButtonElement.prototype, 'disabled');
  Object.defineProperty(request, 'disabled', { configurable: true, get() { return disabled.get.call(this); },
    set(value) { if (value && h.document.activeElement === this) this.blur(); disabled.set.call(this, value); } });
  request.focus();
  click(h, request);
  assert.notEqual(h.document.activeElement, request, 'the pressed button lost the focus');
  await settle(30);
  const chip = a.querySelector('.je-arr-chip');
  assert.equal(chip.textContent, 'Asked!');
  assert.equal(h.document.activeElement, chip, 'the focus stays on the row, not the top of the page');
  // A later redraw (the details surface forwards every status read) keeps it on the chip.
  controls.update({ key: MOVIE.key, kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 42 } });
  assert.equal(h.document.activeElement, a.querySelector('.je-arr-chip'));
  // Focus the viewer moved elsewhere meanwhile is never taken back.
  const outside = h.document.createElement('button');
  h.document.body.appendChild(outside);
  outside.focus();
  controls.update({ key: MOVIE.key, kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 50 } });
  assert.equal(h.document.activeElement, outside);
  controls.destroy();
});

// ------------------------------------------------------------------ details-page smart actions

const PAGE = '<div id="itemDetailPage"><div class="detailPagePrimaryContent"><div class="detailSection"><h3 class="itemName">Severance</h3></div></div></div>';
const SERIES_STATUS = {
  key: 'tv:tvdb:371980', itemId: 'series1', kind: 'series', stage: 'looking', reason: { code: 'partial' },
  summary: { aired: 26, ready: 12, downloading: 1, missing: 2, longMissing: 0 },
  seasons: [
    { season: 1, itemId: 's1', stage: 'ready', summary: { aired: 9, ready: 9, missing: 0 } },
    // Not monitored in Sonarr: nobody fetches it (Get Season 2).
    { season: 2, itemId: null, stage: 'none', summary: { aired: 10, ready: 0, missing: 0 } },
    // E1–E4 here (three counted), E5 and E8 being looked for, E6 not in the arr (Get missing episodes), E7 downloading.
    { season: 3, itemId: 's3', stage: 'looking', summary: { aired: 7, ready: 3, downloading: 1, missing: 2, longMissing: 0 } }
  ]
};
/** Season 3: E5 and E8 being looked for right now (nothing to ask), E6 not in the arr, E7 downloading. */
const SEASON3 = { items: [{ key: 'tv:tvdb:371980:s3', kind: 'season', episodes: [
  { episode: 1, stage: 'ready', reason: { code: 'ready' } },
  { episode: 5, stage: 'looking', reason: { code: 'looking' } },
  { episode: 6, stage: 'notHere', reason: { code: 'not_in_arr' } },
  { episode: 7, stage: 'downloading', reason: { code: 'downloading' } },
  { episode: 8, stage: 'looking', reason: { code: 'looking' } }
] }] };

test('series page: Get Season 2, Get missing episodes, More… and the cost line; each ask turns into its state', async t => {
  const h = setup(t, { html: PAGE, hash: '#/details?id=series1', status: (path) => path.includes('/item/s3') ? SEASON3 : null, quota: { used: 6, limit: 7, remaining: 1, available: true } });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, { contact: 'Dad' });
  await settle();
  const box = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
  assert.ok(box);
  assert.deepEqual([...box.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['Get Season 2', 'Get missing episodes', 'More…']);
  assert.equal(box.querySelector('.je-ask-action-cost').textContent, 'Uses 1 of your 1 this week');
  assert.doesNotMatch(box.textContent, ARR_WORDS);

  const [season, missing] = box.querySelectorAll('.je-ask-action');
  season.focus();
  click(h, season);
  await settle(20);
  assert.deepEqual([...h.posts[0].body.input.seasons], [2]);
  assert.equal(h.posts[0].body.input.scope, 'seasons');
  const chip = box.querySelector('.je-arr-chip');
  assert.equal(chip.textContent, 'Asked!');
  assert.equal(h.document.activeElement, chip, 'focus stays where the button was');

  click(h, missing);
  await settle(20);
  assert.ok(h.statusCalls.some(p => p.includes('/acquire/status/item/s3')), 'reads the season with missing episodes');
  const input = h.posts[1].body.input;
  assert.equal(input.scope, 'episodes');
  assert.deepEqual(input.episodes.map(e => `${e.season}x${e.episode}`), ['3x6']);

  // A later status read draws the states again (the page remembers its asks).
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, { contact: 'Dad' });
  await settle();
  assert.deepEqual([...page.querySelectorAll('.je-ask-actions .je-arr-chip')].map(n => n.textContent), ['Asked!', 'Asked!']);
});

test('a series or season that isn\'t in the library (native details): Get Season N and Request; library seasons stay with the rows', async t => {
  const SERIES_PAGE = '4a45ad120001479b00000000c8f267bc';
  const SEASON_PAGE = '4a45ad130001479b0001000092805890';
  const h = setup(t, { html: PAGE, hash: `#/details?id=${SERIES_PAGE}`, item: { Id: SERIES_PAGE, Name: 'Andor', ProductionYear: 2022 } });
  h.JE.titleDetails = { isSynthetic: id => String(id || '').startsWith('4a45ad1') };
  const page = h.document.getElementById('itemDetailPage');
  const absent = {
    key: 'tv:tvdb:393189', itemId: SERIES_PAGE, kind: 'series', stage: 'notHere', reason: { code: 'not_in_arr' },
    seasons: [{ season: 1, itemId: SEASON_PAGE, stage: 'notHere', summary: { aired: 12, ready: 0 } }, { season: 2, stage: 'notHere', summary: { aired: 12, ready: 0 } },
      // Every season of a title that isn't here has a page id: none of them is "partly here".
      { season: 3, itemId: '4a45ad130001479b00030000aaaaaaaa', stage: 'notHere', summary: { aired: 10, ready: 0 } }]
  };
  h.JE.internals.arrAskActions.attachDetails(page, absent, { contact: 'Dad' });
  await settle();
  let box = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
  // "More…" is the title's Request here; nothing counts as "missing episodes" of a title that isn't here.
  assert.deepEqual([...box.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['Get Season 1', 'Request']);
  click(h, box.querySelectorAll('.je-ask-action')[1]);
  await settle(20);
  assert.ok(sheetEl(h), 'Request opens the request sheet');
  assert.deepEqual([...h.document.querySelectorAll('.je-sheet-card')].length > 0, true);
  key(h, 'Escape');
  await settle();
  // Season 1 already asked for (the server reads that season as asked): Season 2 is the one to get next.
  const asked = { ...absent, stage: 'asked', reason: { code: 'awaiting_approval' }, seasons: [{ ...absent.seasons[0], stage: 'asked' }, absent.seasons[1]] };
  h.JE.internals.arrAskActions.attachDetails(page, asked, { contact: 'Dad' });
  await settle();
  box = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
  assert.deepEqual([...box.querySelectorAll('.je-ask-action-text')].map(n => n.textContent).filter(t => /Season/.test(t)), ['Get Season 2']);
  // A season page of it: Get Season 1, asked as that season.
  const season = { key: 'tv:tvdb:393189:s1', itemId: SEASON_PAGE, kind: 'season', stage: 'notHere', reason: { code: 'not_in_arr' }, summary: { aired: 12, ready: 0 }, episodes: [] };
  h.JE.internals.arrAskActions.attachDetails(page, season, { contact: 'Dad' });
  await settle();
  box = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
  assert.deepEqual([...box.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['Get Season 1']);
  click(h, box.querySelector('.je-ask-action'));
  await settle(20);
  assert.equal(h.posts.at(-1).body.input.key, 'tv:tvdb:393189');
  assert.deepEqual([...h.posts.at(-1).body.input.seasons], [1]);
  // Something of the season is on its way, or a library season: no season action.
  h.JE.internals.arrAskActions.attachDetails(page, { ...season, summary: { aired: 12, downloading: 2 } }, { contact: 'Dad' });
  await settle();
  assert.equal(page.querySelector('.je-ask-actions[data-je-ask-surface="details"]'), null);
  h.JE.internals.arrAskActions.attachDetails(page, { ...season, itemId: 'season1' }, { contact: 'Dad' });
  await settle();
  assert.equal(page.querySelector('.je-ask-actions[data-je-ask-surface="details"]'), null);
});

test('the page of a title that isn\'t in the library places the smart actions itself (in its native action row), and is told when they go', async t => {
  const SERIES_PAGE = '4a45ad120001479b00000000c8f267bc';
  const h = setup(t, { html: PAGE.replace('</h3>', '</h3><div class="mainDetailButtons"></div>'), hash: `#/details?id=${SERIES_PAGE}`, item: { Id: SERIES_PAGE, Name: 'Andor' } });
  h.JE.titleDetails = { isSynthetic: id => String(id || '').startsWith('4a45ad1') };
  const page = h.document.getElementById('itemDetailPage');
  const calls = [];
  h.JE.internals.nativeDetails = {
    placeActions: (p, box, old) => {
      calls.push([box ? [...box.querySelectorAll('.je-ask-action-text')].map(n => n.textContent) : null, !!old]);
      if (old && old !== box) old.remove();
      if (box) p.querySelector('.mainDetailButtons').appendChild(box);
      return true;
    }
  };
  const absent = { key: 'tv:tvdb:393189', itemId: SERIES_PAGE, kind: 'series', stage: 'notHere', reason: { code: 'not_in_arr' }, seasons: [{ season: 1, itemId: '4a45ad130001479b0001000092805890', stage: 'notHere', summary: { aired: 12, ready: 0 } }] };
  h.JE.internals.arrAskActions.attachDetails(page, absent, { contact: 'Dad' });
  await settle();
  const box = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
  assert.equal(box.parentElement, page.querySelector('.mainDetailButtons'));
  assert.deepEqual(calls, [[['Get Season 1', 'Request'], false]]);
  // Nothing to offer (a movie for someone who can't ask for 4K): no actions, and the page is told so (its cost
  // lines go too).
  h.JE.internals.arrAskActions.attachDetails(page, { key: 'movie:tmdb:1', itemId: '4a45ad11000a938e00000000f9c67720', kind: 'movie', stage: 'notHere' }, { contact: 'Dad' });
  await settle();
  assert.deepEqual(calls.at(-1), [null, true]);
  assert.equal(page.querySelector('.je-ask-actions[data-je-ask-surface="details"]'), null);
  // Taken away for good (no status, or the viewer can't ask): the page is told too, so a box it holds out of
  // the page while its row is drawn anew doesn't come back with the row.
  h.JE.internals.arrAskActions.attachDetails(page, absent, { contact: 'Dad' });
  await settle();
  const told = calls.length;
  h.JE.internals.arrAskActions.attachDetails(page, null);
  await settle();
  assert.deepEqual(calls.slice(told), [[null, false]]);
  assert.equal(page.querySelector('.je-ask-actions[data-je-ask-surface="details"]'), null);
  // A page that doesn't place them (a library title) keeps them under the status as before.
  h.JE.internals.nativeDetails.placeActions = () => false;
  h.JE.internals.arrAskActions.attachDetails(page, absent, { contact: 'Dad' });
  await settle();
  assert.equal(page.querySelector('.je-ask-actions[data-je-ask-surface="details"]').parentElement, page.querySelector('.detailSection'));
});

test('series page for a kid: "Ask Dad for Season 2"; Watchers and the feature off show nothing', async t => {
  const h = setup(t, { me: KID, html: PAGE, hash: '#/details?id=series1' });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, {});
  await settle();
  assert.deepEqual([...page.querySelectorAll('.je-ask-action-text')].map(n => n.textContent).slice(0, 2), ['Ask Dad for Season 2', 'Ask Dad for the missing episodes']);

  h.state.me = WATCHER;
  await h.JE.arrAsk.me(true);
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-actions'), null);

  h.state.me = MEMBER;
  await h.JE.arrAsk.me(true);
  h.JE.pluginConfig.ArrRequestsEnabled = false;
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-actions'), null);
  // Season and episode pages are the season rows' business.
  h.JE.pluginConfig.ArrRequestsEnabled = true;
  h.JE.internals.arrAskActions.attachDetails(page, { ...SERIES_STATUS, kind: 'season' }, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-actions'), null);
});

test('seasons the viewer already asked for (Sonarr now looking for them) are not offered again on the series page or in its sheet', async t => {
  const h = setup(t, { html: PAGE, hash: '#/details?id=series1', item: { Id: 'series1', Name: 'Severance', ProductionYear: 2022 } });
  const page = h.document.getElementById('itemDetailPage');
  // The viewer asked for seasons 2 and 3: Sonarr holds them now, so their stage is its own ("looking").
  h.JE.internals.arrAskActions.attachDetails(page, { ...SERIES_STATUS, askedSeasons: [2, 3] }, {});
  await settle();
  const texts = () => [...page.querySelectorAll('.je-ask-actions .je-ask-action-text')].map(n => n.textContent);
  assert.deepEqual(texts(), ['More…']);
  click(h, [...page.querySelectorAll('.je-ask-action')].find(b => b.textContent.includes('More…')));
  await settle(20);
  assert.equal(card(h, 'everything'), null, 'nothing left to ask for as a whole');
  key(h, 'Escape');
  await settle();
  // Only season 2 asked: season 3's missing episodes are still offered, season 2 isn't.
  h.JE.internals.arrAskActions.attachDetails(page, { ...SERIES_STATUS, askedSeasons: [2] }, {});
  await settle();
  assert.deepEqual(texts(), ['Get missing episodes', 'More…']);
  // The next season to get is one they asked for: "Next season only" isn't offered for it.
  const next = { ...SERIES_STATUS, seasons: SERIES_STATUS.seasons.slice(0, 2), askedSeasons: [2] };
  h.JE.internals.arrAskActions.attachDetails(page, next, {});
  await settle();
  click(h, [...page.querySelectorAll('.je-ask-action')].find(b => b.textContent.includes('More…')));
  await settle(20);
  assert.equal(card(h, 'next'), null);
  key(h, 'Escape');
  await settle();
});

test('More… opens the sheet with the series seasons and returns focus to it', async t => {
  const h = setup(t, { html: PAGE, hash: '#/details?id=series1', item: { Id: 'series1', Name: 'Severance', ProductionYear: 2022, ImageTags: { Primary: 'tag1' } } });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, {});
  await settle();
  const more = [...page.querySelectorAll('.je-ask-action')].find(b => b.textContent.includes('More…'));
  assert.equal(more.getAttribute('aria-label'), 'More ways to get Severance');
  more.focus();
  click(h, more);
  await settle(20);
  assert.equal(h.document.querySelector('.je-sheet-title').textContent, 'Get Severance');
  assert.equal(h.document.querySelector('.je-sheet-facts').textContent, '3 seasons · 26 episodes');
  assert.equal(card(h, 'everything').querySelector('.je-sheet-card-label').textContent, 'Everything (2 seasons)');
  assert.ok(h.document.querySelector('img.je-sheet-poster').src.startsWith('http://jellyfin.test/Items/series1/Images/Primary'));
  key(h, 'Escape');
  await settle();
  assert.equal(h.document.activeElement, more);
});

test('a movie in the library: Get 4K only for 4K holders and only without a 4K copy', async t => {
  const movieStatus = { key: 'movie:tmdb:603', itemId: 'm1', kind: 'movie', stage: 'ready', reason: { code: 'ready' }, quiet: true };
  const hd = { Id: 'm1', MediaSources: [{ MediaStreams: [{ Type: 'Video', Width: 1920, Height: 1080 }] }] };
  const uhd = { Id: 'm1', MediaSources: [{ MediaStreams: [{ Type: 'Video', Width: 3840, Height: 2160 }] }] };
  let item = hd;
  const h = setup(t, { html: PAGE, hash: '#/details?id=m1', item: () => item });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, movieStatus, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-actions'), null, 'no 4K for a member without it');

  h.state.me = { ...MEMBER, can4kMovies: true };
  await h.JE.arrAsk.me(true);
  h.JE.internals.arrAskActions.attachDetails(page, movieStatus, {});
  await settle();
  const get4k = page.querySelector('.je-ask-action');
  assert.equal(get4k.textContent, '4kGet 4K');
  click(h, get4k);
  await settle(20);
  assert.equal(h.posts[0].body.input.variant, '4k');
  assert.equal(page.querySelector('.je-ask-actions .je-arr-chip').textContent, 'Asked!');

  item = uhd;
  h.JE.internals.arrAskActions.attachDetails(page, { ...movieStatus, key: 'movie:tmdb:604' }, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-actions'), null, 'a 4K copy is here already');
});

// ------------------------------------------------------------------ Search (missing for a long while)

const ADMIN = { ...MEMBER, role: 'admin', canApprove: true };
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const LONG_MISSING_EPISODE = {
  key: 'tv:tvdb:371980:s3:e5', itemId: 'e5', kind: 'episode', stage: 'looking', reason: { code: 'no_release_yet' }
};
const ADMIN_BLOCK = { variants: [{ instance: 'Sonarr', instanceId: 'son1', kind: 'Sonarr', role: 'standard', stage: 'looking', reason: { code: 'no_release_yet' }, fix: 'search_now' }] };

test('a Kid\'s Search of an episode requests already sent reads plain Search and runs with no new OK', async t => {
  const h = setup(t, {
    html: PAGE, hash: '#/details?id=e5', me: KID,
    routes: (method, path) => (method === 'POST' && path === '/acquire/requests/search' ? { status: 200, body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Searching.', found: false } } : null)
  });
  const page = h.document.getElementById('itemDetailPage');
  // The missing status says a request covering it already went out.
  h.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, reason: { code: 'no_release_yet', params: { sent: '1' } } }, {});
  await settle();
  const search = page.querySelector('.je-ask-action');
  assert.equal(search.textContent, 'searchSearch');
  click(h, search);
  await settle(20);
  assert.equal(h.searches.length, 1, 'the family Search runs');
  assert.equal(h.posts.length, 0, 'no new ask, so nothing waits for an OK');
  // Helper: only a caller whose asks wait for an OK, on a part nothing has gone out for, gets "Ask Dad to search".
  assert.equal(h.JE.arrAsk.searchAsksFirst(KID, LONG_MISSING_EPISODE), true);
  assert.equal(h.JE.arrAsk.searchAsksFirst(KID, { ...LONG_MISSING_EPISODE, reason: { code: 'no_release_yet', params: { sent: '1' } } }), false);
  assert.equal(h.JE.arrAsk.searchAsksFirst(MEMBER, LONG_MISSING_EPISODE), false);
});

test('the request controls\' Search on a movie requests already sent reads plain Search for a Kid', async t => {
  const h = setup(t, { me: KID });
  const host = h.document.createElement('div');
  h.document.body.appendChild(host);
  const controls = h.Sheet.mount(host, { key: 'movie:tmdb:1084242', kind: 'movie', name: 'Toy Story 5' });
  controls.update({ key: 'movie:tmdb:1084242', kind: 'movie', stage: 'looking', reason: { code: 'no_release_yet', params: { sent: '1' } } });
  await settle(20);
  const button = host.querySelector('.je-ask-mount-search');
  assert.ok(button, 'a Search button');
  assert.match(button.textContent, /Search$/);
  assert.doesNotMatch(button.textContent, /Ask Dad/);
  controls.update({ key: 'movie:tmdb:1084242', kind: 'movie', stage: 'looking', reason: { code: 'no_release_yet' } });
  await settle(20);
  assert.match(host.querySelector('.je-ask-mount-search').textContent, /Ask Dad to search/);
  controls.destroy();
});

test('an episode missing for a long while: Search; a Kid asks Dad, a member asks, a fresh one keeps Get it', async t => {
  const h = setup(t, { html: PAGE, hash: '#/details?id=e5', me: KID });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, LONG_MISSING_EPISODE, {});
  await settle();
  const ask = page.querySelector('.je-ask-action');
  assert.equal(ask.textContent, 'searchAsk Dad to search');
  click(h, ask);
  await settle(20);
  same(h.posts[0].body.input, { key: 'tv:tvdb:371980', scope: 'episodes', variant: 'standard', seasons: [], episodes: [{ season: 3, episode: 5 }] });

  h.state.me = MEMBER;
  await h.JE.arrAsk.me(true);
  h.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, key: 'tv:tvdb:371980:s3:e6' }, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-action').textContent, 'searchSearch');
  h.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, key: 'tv:tvdb:371980:s3:e7', reason: { code: 'looking' } }, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-actions'), null, 'still fresh: Sonarr is looking for it, nothing to ask for');
  // Not monitored: Get it.
  h.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, key: 'tv:tvdb:371980:s3:e8', stage: 'notHere', reason: { code: 'unmonitored' } }, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-action').textContent, 'addGet it');
});

test('an administrator\'s Search on an episode page runs the arr search at once and says what it found', async t => {
  const h = setup(t, {
    html: PAGE, hash: '#/details?id=e5', me: ADMIN, config: { ArrManageDrawerEnabled: true },
    routes: (method, path) => (method === 'POST' && path === '/arr/admin/manage/search' ? { body: { status: 'Succeeded', found: true } } : null)
  });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, admin: ADMIN_BLOCK }, {});
  await settle();
  const search = page.querySelector('.je-ask-action');
  assert.equal(search.textContent, 'searchSearch');
  click(h, search);
  assert.equal(search.querySelector('.je-ask-action-text').textContent, 'Searching…');
  await settle(20);
  same(h.posts.map(p => [p.path, p.body.instanceId, p.body.key]), [['/arr/admin/manage/search', 'son1', 'tv:tvdb:371980:s3:e5']]);
  assert.equal(page.querySelector('.je-ask-actions .je-arr-chip').textContent, 'Found a copy');
  same(h.toasts, ['Found a copy — downloading']);
});

test('mount API: a title missing for a long while gets Search (an ask for members, the arr search for admins)', async t => {
  const h = setup(t, {
    html: '<div id="a"></div><div id="b"></div>', config: { ArrManageDrawerEnabled: true },
    routes: (method, path) => (method === 'POST' && path === '/arr/admin/manage/search' ? { body: { status: 'Succeeded', found: false } } : null)
  });
  const a = h.document.getElementById('a');
  const controls = h.Sheet.mount(a, MOVIE);
  await settle();
  controls.update({ key: MOVIE.key, kind: 'movie', stage: 'looking', reason: { code: 'no_release_yet' } });
  const search = a.querySelector('.je-ask-mount-search');
  assert.equal(search.textContent, 'searchSearch');
  click(h, search);
  await settle(20);
  same(h.posts[0].body.input, { key: MOVIE.key, scope: 'movie', variant: 'standard', seasons: [], episodes: [] });
  assert.equal(a.querySelector('.je-arr-chip').textContent, 'Asked!');
  controls.destroy();

  h.state.me = ADMIN;
  await h.JE.arrAsk.me(true);
  const b = h.document.getElementById('b');
  const admin = h.Sheet.mount(b, MOVIE);
  await settle();
  admin.update({ key: MOVIE.key, kind: 'movie', stage: 'looking', reason: { code: 'no_release_yet' }, admin: { variants: [{ instance: 'Radarr', instanceId: 'rad1', kind: 'Radarr', role: 'standard', stage: 'looking', reason: { code: 'no_release_yet' } }] } });
  click(h, b.querySelector('.je-ask-mount-search'));
  await settle(20);
  same([h.posts[1].path, h.posts[1].body.instanceId, h.posts[1].body.key], ['/arr/admin/manage/search', 'rad1', MOVIE.key]);
  assert.equal(b.querySelector('.je-arr-chip').textContent, 'Nothing found yet · searched just now');
  assert.equal(h.toasts.at(-1), 'Nothing found yet · searched just now');
  admin.destroy();
});

test('a family Search on an episode page or a mounted movie searches again what a request already sent, instead of asking', async t => {
  let answer = { body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Searched for it.', found: true } };
  const h = setup(t, {
    html: PAGE + '<div id="m"></div>', hash: '#/details?id=e5', me: KID,
    routes: (method, path) => (method === 'POST' && path === '/acquire/requests/search' ? answer : null)
  });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, LONG_MISSING_EPISODE, {});
  await settle();
  click(h, page.querySelector('.je-ask-action'));
  await settle(20);
  same(h.searches.map(p => p.body.key), ['tv:tvdb:371980:s3:e5']);
  assert.match(h.searches[0].body.idempotencyKey, /\S{8,}/);
  same(h.posts, [], 'no request: it was already sent');
  assert.equal(page.querySelector('.je-ask-actions .je-arr-chip').textContent, 'Found a copy');
  same(h.toasts, ['Found a copy — downloading']);

  // Searched lately (the household's one search for this looking period): said plainly, still no request.
  answer = { status: 429, body: { outcome: 'blocked', reason: 'searched_recently', certainty: 'Rejected', message: 'Searched for it a little while ago.' } };
  h.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, key: 'tv:tvdb:371980:s3:e6' }, {});
  await settle();
  click(h, page.querySelector('.je-ask-action'));
  await settle(20);
  same(h.posts, []);
  assert.equal(h.toasts.at(-1), "Searched for it a little while ago. We'll keep looking.");

  // A mounted movie (the title page): Search runs the family search first.
  answer = { body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Searched for it.', found: false } };
  h.state.me = MEMBER;
  await h.JE.arrAsk.me(true);
  const m = h.document.getElementById('m');
  const controls = h.Sheet.mount(m, MOVIE);
  await settle();
  controls.update({ key: MOVIE.key, kind: 'movie', stage: 'looking', reason: { code: 'no_release_yet' } });
  click(h, m.querySelector('.je-ask-mount-search'));
  await settle(20);
  same(h.searches.at(-1).body.key, MOVIE.key);
  same(h.posts, []);
  assert.equal(m.querySelector('.je-arr-chip').textContent, 'Nothing found yet · searched just now');
  controls.destroy();
});

// ------------------------------------------------------------------ collections

const BOX_PAGE = '<div id="itemDetailPage"><div class="detailPagePrimaryContent"><div class="detailSection"></div></div></div>';
const GAPS = {
  have: 4, total: 7,
  missing: [
    { key: 'movie:tmdb:11', title: 'Part Five', year: 2008, poster: '/p5.jpg', released: true, request: null },
    { key: 'movie:tmdb:12', title: 'Part Six', year: 2011, poster: null, released: true, request: null },
    { key: 'movie:tmdb:13', title: 'Part Seven', year: 2012, poster: null, released: true, request: null },
    { key: 'movie:tmdb:14', title: 'Part Eight', year: 2031, poster: null, released: false, request: null }
  ]
};

test('collection page: "You have 4 of 7", the cost preview, then an honest summary of each ask', async t => {
  let gaps = GAPS;
  const answers = {
    'movie:tmdb:11': { status: 201, body: { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded' } },
    'movie:tmdb:12': { status: 201, body: { outcome: 'accepted', reason: 'over_quota', certainty: 'Succeeded' } },
    'movie:tmdb:13': { status: 503, body: { outcome: 'unavailable', reason: 'database_unavailable', certainty: 'Failed' } }
  };
  const h = setup(t, {
    html: BOX_PAGE, hash: '#/details?id=box1', item: { Id: 'box1', Type: 'BoxSet' },
    quota: { used: 5, limit: 7, remaining: 2, available: true },
    routes: (method, path) => path.startsWith('/acquire/requests/collection/box1') ? { body: { outcome: 'accepted', reason: 'collection', collection: gaps } } : null,
    answer: (input) => answers[input.key]
  });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, null);
  await settle(20);
  const block = page.querySelector('.je-ask-coll');
  assert.ok(block);
  assert.match(block.querySelector('.je-ask-coll-have').textContent, /You have 4 of 7\./);
  assert.equal(block.querySelector('.je-ask-coll-get').textContent, 'downloadGet the 3 missing');
  assert.equal(block.querySelector('.je-ask-coll-cost').textContent, "Uses 2 of your 2 this week; 1 need Dad's OK");
  assert.deepEqual([...block.querySelectorAll('.je-ask-coll-part')].map(li => li.textContent), ['Part Five (2008)', 'Part Six (2011)', 'Part Seven (2012)', 'Part Eight (2031)Not out yet']);
  assert.doesNotMatch(block.textContent, ARR_WORDS);

  gaps = { ...GAPS, missing: GAPS.missing.map(p => p.key === 'movie:tmdb:11' ? { ...p, request: 'asked' } : p.key === 'movie:tmdb:12' ? { ...p, request: 'waiting' } : p) };
  click(h, block.querySelector('.je-ask-coll-get'));
  await settle(60);
  assert.deepEqual(h.posts.map(p => p.body.input.key), ['movie:tmdb:11', 'movie:tmdb:12', 'movie:tmdb:13'], 'released ones only, one by one');
  assert.equal(new Set(h.posts.map(p => p.body.clientRequestId)).size, 3, 'each its own ask');
  const line = "Asked for 1 · 1 waits for Dad's OK · 1 couldn't be asked";
  assert.deepEqual(h.toasts, [line]);
  const after = page.querySelector('.je-ask-coll');
  assert.equal(after.querySelector('.je-ask-coll-summary').textContent, line);
  assert.deepEqual([...after.querySelectorAll('.je-ask-coll-part .je-arr-chip')].map(c => c.textContent), ['Asked!', 'Waiting for OK', 'Not out yet']);
  assert.equal(after.querySelector('.je-ask-coll-get').textContent, 'downloadGet the missing one');
});

test('collection preview for kids and the summary words', async t => {
  const h = setup(t, { me: KID });
  const C = h.JE.internals.arrAskCollection;
  assert.equal(C.costPreview(2, KID, null), "2 need Dad's OK");
  assert.equal(C.costPreview(2, MEMBER, { limit: 5, remaining: 5, available: true }), 'Uses 2 of your 5 this week');
  assert.equal(C.costPreview(2, MEMBER, { limit: 5, remaining: 0, available: true }), "2 need Dad's OK");
  assert.equal(C.costPreview(2, MEMBER, { limit: null, remaining: null, available: true }), '');
  assert.equal(C.costPreview(2, { ...MEMBER, backend: 'seerr' }, { limit: 5, remaining: 0, available: true }), "You've used this week's requests");
  assert.equal(C.summarize([{ state: 'waiting' }, { state: 'waiting' }, { state: 'nothing' }, { state: 'failed' }, { state: 'denied' }], MEMBER),
    "2 wait for Dad's OK · 1 already here or on the way · 2 couldn't be asked");
  assert.equal(C.summarize([{ state: 'asked' }, { state: 'merged' }, { state: 'unknown' }], MEMBER), 'Asked for 3');
});

test('a collection answer is shown only while its page, user and request are still current', async t => {
  const slow = { box1: deferred(), box3: deferred() };
  let reads = 0;
  const h = setup(t, {
    html: BOX_PAGE, hash: '#/details?id=box1', item: (id) => ({ Id: id, Type: 'BoxSet' }),
    routes: async (method, path) => {
      if (!path.startsWith('/acquire/requests/collection/')) return null;
      reads++;
      const id = /collection\/(\w+)/.exec(path)[1];
      if (slow[id]) await slow[id].promise;
      return { body: { collection: { ...GAPS, have: id === 'box1' ? 1 : 2 } } };
    }
  });
  const page = h.document.getElementById('itemDetailPage');
  const C = h.JE.internals.arrAskCollection;
  C.attach(page, 'box1');
  await settle();
  // The person moves on to another collection before the first answer arrives.
  h.window.location.hash = '#/details?id=box2';
  C.attach(page, 'box2');
  await settle(20);
  slow.box1.resolve();
  await settle(20);
  assert.equal(reads, 2);
  assert.match(page.querySelector('.je-ask-coll-have').textContent, /You have 2 of 7/);

  // A user switch while the read is out: the old user's answer is dropped.
  C.clear(page);
  h.window.location.hash = '#/details?id=box3';
  const pending = C.attach(page, 'box3');
  await settle(10);
  assert.equal(reads, 3, 'the read is out');
  h.JE.session.epoch = 1;
  slow.box3.resolve();
  await pending;
  await settle(20);
  assert.equal(page.querySelector('.je-ask-coll'), null);
});

test('not a collection, no gaps, or the feature off: no block and no collection read', async t => {
  const h = setup(t, { html: BOX_PAGE, hash: '#/details?id=p1', item: { Id: 'p1', Type: 'Person' } });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, null);
  await settle(20);
  assert.equal(page.querySelector('.je-ask-coll'), null);
  assert.ok(!h.gets.some(p => p.startsWith('/acquire/requests/collection/')));
  h.JE.pluginConfig.ArrRequestsEnabled = false;
  h.JE.internals.arrAskActions.attachDetails(page, null);
  await settle(20);
  assert.equal(h.gets.length, 0);
});

test('nothing reaches the network while the modules load', async t => {
  const h = setup(t);
  await settle(5);
  assert.equal(h.gets.length + h.posts.length + h.statusCalls.length, 0);
  assert.equal(typeof h.JE.arrAskSheet.mount, 'function');
  assert.ok(Object.isFrozen(h.JE.arrAskSheet));
});

// ------------------------------------------------------------------ review round 1

test('episode costs follow the episodes already charged this window, as the server charges them', async t => {
  const h = setup(t, { quota: { used: 1, limit: 7, remaining: 6, nextSlotAt: null, usedGb: 0, available: true, episodes: 5 } });
  const I = h.JE.internals.arrAskSheet;
  assert.equal(I.costOf({ scope: 'episodes', episodes: [{}] }, MEMBER, { episodes: 5 }), 1, 'the free ones are used up');
  assert.equal(I.costOf({ scope: 'episodes', episodes: [{}, {}] }, MEMBER, { episodes: 3 }), 0);
  assert.equal(I.costOf({ scope: 'episodes', episodes: [{}, {}, {}] }, MEMBER, { episodes: 3 }), 1);
  assert.equal(I.costOf({ scope: 'episodes', episodes: [{}] }, MEMBER, null), 0, 'nothing charged yet: free');
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  click(h, card(h, 'episodes'));
  click(h, h.document.querySelector('.je-sheet-episode[data-episode="1"]'));
  assert.equal(costText(h, 'episodes'), 'Uses 1 of your 6 this week');
  h.Sheet.close();
  assert.equal(await pending, null);
});

test('a series named without its seasons (search and Discover cards) has them read before the sheet opens', async t => {
  const tmdb = { seasons: [
    { season_number: 0, episode_count: 3, air_date: '2010-01-01' },
    { season_number: 1, episode_count: 10, air_date: '2011-04-17' },
    { season_number: 2, episode_count: 8, air_date: '2012-04-01' },
    { season_number: 3, episode_count: 9, air_date: '2999-01-01' }
  ] };
  const h = setup(t, { routes: (method, path) => (path === '/tmdb/tv/1399' ? { body: tmdb } : null) });
  const pending = h.Sheet.open({ key: 'tv:tmdb:1399', kind: 'series', name: 'A show', year: 2011, poster: '/p.jpg' }, { operation: h.NATIVE });
  await settle();
  assert.ok(h.gets.includes('/tmdb/tv/1399'));
  same([...h.document.querySelectorAll('.je-sheet-card')].map(c => c.dataset.choice), ['everything', 'latest', 'next', 'pick', 'episodes', 'future']);
  click(h, card(h, 'everything'));
  click(h, primary(h));
  await settle(20);
  same(h.posts[0].body.input, { key: 'tv:tmdb:1399', scope: 'seasons', variant: 'standard', seasons: [1, 2], episodes: [] });
  assert.equal((await pending).ok, true);

  // TMDB can't be read (or a parental refusal): say so instead of an empty sheet.
  const none = setup(t, { routes: (method, path) => (path.startsWith('/tmdb/') ? { status: 403, body: {} } : null) });
  assert.equal(await none.Sheet.open({ key: 'tv:tmdb:7', kind: 'series', name: 'Hidden' }, { operation: none.NATIVE }), null);
  assert.equal(sheetEl(none), null);
  same(none.toasts, ["Couldn't load this series' seasons. Try again in a moment."]);
});

const SERIES_NOTHING = {
  key: 'tv:tvdb:371980', itemId: 'series1', kind: 'series', stage: 'looking', reason: { code: 'no_release_yet' },
  summary: { aired: 16, ready: 0, missing: 16, longMissing: 16 },
  seasons: [
    { season: 1, itemId: 's1', stage: 'looking', summary: { aired: 10, ready: 0, missing: 10, longMissing: 10 } },
    { season: 2, itemId: 's2', stage: 'looking', summary: { aired: 6, ready: 0, missing: 6, longMissing: 6 } }
  ]
};

test('a series missing for a long while: Search for everyone who may ask (members and kids through a request)', async t => {
  const h = setup(t, { html: PAGE, hash: '#/details?id=series1', me: KID });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_NOTHING, { contact: 'Dad' });
  await settle();
  const texts = () => [...page.querySelectorAll('.je-ask-actions .je-ask-action-text')].map(n => n.textContent);
  // Missing for a long while: Search only (never Get Season N / Get missing episodes: requests may have sent them).
  same(texts(), ['Ask Dad to search', 'More…']);
  click(h, [...page.querySelectorAll('.je-ask-actions .je-ask-action')].find(b => b.textContent.endsWith('Ask Dad to search')));
  await settle(20);
  // The family search goes first; nothing was sent for the series yet, so it asks for the seasons.
  same(h.searches.map(s => s.body.key), ['tv:tvdb:371980']);
  same(h.posts.map(p => p.path), ['/acquire/requests']);
  same(h.posts[0].body.input, { key: 'tv:tvdb:371980', scope: 'seasons', variant: 'standard', seasons: [1, 2], episodes: [] });

  h.state.me = MEMBER;
  await h.JE.arrAsk.me(true);
  h.JE.internals.arrAskActions.attachDetails(page, { ...SERIES_NOTHING, key: 'tv:tvdb:1' }, { contact: 'Dad' });
  await settle();
  same(texts(), ['Search', 'More…']);
  // Seen live (Black Books): S1 partly here, S2–S3 asked, sent and missing for a long while, the series reading
  // "partial": Search for them, no Get Season 2 / Get missing episodes.
  const partly = { ...SERIES_NOTHING, key: 'tv:tvdb:76924', reason: { code: 'partial' }, summary: { aired: 18, ready: 5, missing: 13, longMissing: 13 }, seasons: [
    { season: 1, itemId: 's1', stage: 'looking', summary: { aired: 6, ready: 5, missing: 1, longMissing: 1 } },
    { season: 2, itemId: null, stage: 'looking', summary: { aired: 6, ready: 0, missing: 6, longMissing: 6 } },
    { season: 3, itemId: null, stage: 'looking', summary: { aired: 6, ready: 0, missing: 6, longMissing: 6 } }
  ] };
  page.querySelectorAll('.je-ask-actions').forEach(n => n.remove());   // another series' page
  h.JE.internals.arrAskActions.attachDetails(page, partly, { contact: 'Dad' });
  await settle();
  same(texts(), ['Search', 'More…']);
  click(h, [...page.querySelectorAll('.je-ask-actions .je-ask-action')].find(b => b.textContent.endsWith('Search')));
  await settle(20);
  assert.equal(h.searches[h.searches.length - 1]?.body?.key, 'tv:tvdb:76924');

  // Still fresh (Sonarr is looking for every episode right now): nothing to ask for, no Search; More… only.
  const fresh = { ...SERIES_NOTHING, key: 'tv:tvdb:2', reason: { code: 'looking' }, summary: { aired: 16, ready: 0, missing: 16 },
    seasons: SERIES_NOTHING.seasons.map(s => ({ ...s, summary: { ...s.summary, longMissing: 0 } })) };
  h.JE.internals.arrAskActions.attachDetails(page, fresh, { contact: 'Dad' });
  await settle();
  same(texts(), ['More…']);
  // Season 2 partly here with only fresh episodes missing, Season 3 not monitored at all: Get Season 3 only.
  const mixed = { ...fresh, key: 'tv:tvdb:3', seasons: [
    { season: 1, itemId: 's1', stage: 'looking', summary: { aired: 10, ready: 0, missing: 10 } },
    { season: 2, itemId: 's2', stage: 'looking', summary: { aired: 6, ready: 3, missing: 3 } },
    { season: 3, itemId: 's3', stage: 'none', summary: { aired: 8, ready: 0 } }
  ] };
  h.JE.internals.arrAskActions.attachDetails(page, mixed, { contact: 'Dad' });
  await settle();
  same(texts(), ['Get Season 3', 'More…']);
});

test('a whole-series Search of episodes requests already sent searches them again: no new ask, no OK (series page and request controls)', async t => {
  const h = setup(t, {
    html: PAGE + '<div id="m"></div>', hash: '#/details?id=series1', me: KID,
    routes: (method, path) => (method === 'POST' && path === '/acquire/requests/search' ? { body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Searched for it.', found: false } } : null)
  });
  const page = h.document.getElementById('itemDetailPage');
  // Every episode still to come is missing for a long while, and a request already sent every one of them.
  const sent = { ...SERIES_NOTHING, reason: { code: 'no_release_yet', params: { sent: '1' } } };
  h.JE.internals.arrAskActions.attachDetails(page, sent, { contact: 'Dad' });
  await settle();
  const search = [...page.querySelectorAll('.je-ask-actions .je-ask-action')].find(b => b.textContent === 'searchSearch');
  assert.ok(search, 'plain Search for a Kid: nothing new to OK');
  click(h, search);
  await settle(20);
  same(h.searches.map(s => s.body.key), ['tv:tvdb:371980']);
  same(h.posts, [], 'no new request for the seasons');
  assert.equal(page.querySelector('.je-ask-actions .je-arr-chip').textContent, 'Nothing found yet · searched just now');
  same(h.toasts, ['Nothing found yet · searched just now']);

  // The request controls of a series (the Seerr modal, an absent series' page): the same search, no sheet.
  const m = h.document.getElementById('m');
  const controls = h.Sheet.mount(m, { key: 'tv:tvdb:371980', kind: 'series', name: 'Severance' });
  await settle();
  controls.update({ key: 'tv:tvdb:371980', kind: 'series', stage: 'looking', reason: { code: 'no_release_yet', params: { sent: '1' } } });
  await settle(20);
  const mounted = m.querySelector('.je-ask-mount-search');
  assert.match(mounted.textContent, /Search$/);
  assert.doesNotMatch(mounted.textContent, /Ask Dad/);
  click(h, mounted);
  await settle(20);
  same(h.searches.map(s => s.body.key), ['tv:tvdb:371980', 'tv:tvdb:371980']);
  same(h.posts, []);
  assert.equal(sheetEl(h), null, 'no sheet: nothing to ask for');
  assert.equal(m.querySelector('.je-arr-chip').textContent, 'Nothing found yet · searched just now');
  controls.destroy();

  // Helper: series and season keys are searched too; anything else is asked for.
  h.searches.length = 0;
  assert.ok(await h.JE.arrAsk.familySearch('tv:tvdb:371980:s2'));
  assert.equal(await h.JE.arrAsk.familySearch('tv:tvdb:371980:e2'), null);
  assert.equal(await h.JE.arrAsk.familySearch('movie:tmdb:1:s1'), null);
  same(h.searches.map(s => s.body.key), ['tv:tvdb:371980:s2']);
});

test('an ask prepared before a sign-out is not sent as the next person (one tap and the series page)', async t => {
  const h = setup(t, { routes: (method, path) => { if (path.startsWith('/acquire/requests/quota')) h.JE.session.epoch++; return null; } });
  assert.equal(await h.Sheet.openOrAsk(MOVIE, { operation: h.NATIVE }), null);
  await settle();
  assert.equal(h.posts.length, 0, 'the one-tap ask was dropped');
  assert.equal(sheetEl(h), null);

  const p = setup(t, {
    html: PAGE, hash: '#/details?id=series1', quota: { used: 0, limit: 7, remaining: 7, available: true },
    status: (path) => { if (path.includes('/item/s3')) { p.JE.session.epoch++; return SEASON3; } return null; }
  });
  const page = p.document.getElementById('itemDetailPage');
  p.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, { contact: 'Dad' });
  await settle();
  const missing = [...page.querySelectorAll('.je-ask-action')].find(b => b.textContent.endsWith('Get missing episodes'));
  click(p, missing);
  await settle(20);
  assert.ok(p.statusCalls.some(x => x.includes('/item/s3')));
  assert.equal(p.posts.length, 0, 'the episodes read for the old session are not asked for');
  assert.equal(p.toasts.length, 0);
});

// ------------------------------------------------------------------ review round 2

test('4K: seasons here in the library (any quality) stay offered, and the cards follow the copy chosen', async t => {
  const h = setup(t, { me: { ...MEMBER, can4kSeries: true } });
  const HERE = { ...SERIES, seasons: [{ season: 1, episodes: 10, have: 10 }, { season: 2, episodes: 10, have: 10 }], latestSeason: 2, nextSeason: null };
  const pending = h.Sheet.open(HERE, { operation: h.NATIVE });
  await settle();
  const choices = () => [...h.document.querySelectorAll('.je-sheet-card')].map(c => c.dataset.choice);
  const boxes = () => [...h.document.querySelectorAll('.je-sheet-pick input')].map(b => b.disabled);
  // Standard: both seasons are here, so only the pickers and the future card are left.
  same(choices(), ['pick', 'episodes', 'future']);
  same(boxes(), [true, true]);
  const variant = v => h.document.querySelector(`.je-sheet-variant-option[data-variant="${v}"]`);
  variant('4k').focus();
  click(h, variant('4k'));
  same(choices(), ['everything', 'latest', 'pick', 'episodes', 'future'], 'a 4K holder can ask for 4K of what is here');
  same(boxes(), [false, false]);
  assert.equal(h.document.querySelector('.je-sheet-pick .je-sheet-check-facts').textContent, '10 episodes', 'no "All here" for 4K');
  assert.equal(h.document.activeElement, variant('4k'), 'focus stays on the toggle');
  assert.equal(card(h, 'everything').getAttribute('aria-pressed'), 'false', 'the choice made is kept');
  click(h, card(h, 'everything'));
  click(h, primary(h));
  const result = await pending;
  same(h.posts[0].body.input, { key: SERIES.key, scope: 'seasons', variant: '4k', seasons: [1, 2], episodes: [] });
  assert.equal(result.input.variant, '4k', 'the result says what was asked for');
  // Back to Standard: what is here is not offered again.
  const again = h.Sheet.open(HERE, { variant: '4k' , operation: h.NATIVE });
  await settle();
  click(h, variant('standard'));
  same(choices(), ['pick', 'episodes', 'future']);
  h.Sheet.close();
  await again;
});

test('seasons the caller already asked for are not offered again for the standard copy', async t => {
  const h = setup(t, { me: { ...MEMBER, can4kSeries: true } });
  const pending = h.Sheet.open({ ...SERIES, askedSeasons: [2] }, { operation: h.NATIVE });
  await settle();
  const facts = () => [...h.document.querySelectorAll('.je-sheet-pick .je-sheet-check')].map(c => [c.querySelector('input').disabled, c.querySelector('.je-sheet-check-facts')?.textContent]);
  same(facts(), [[true, 'All here'], [true, 'Already asked for'], [false, '6 episodes']]);
  assert.equal(card(h, 'everything').querySelector('.je-sheet-card-label').textContent, en.arr_sheet_card_everything_one, 'one season left to ask for');
  click(h, h.document.querySelector('.je-sheet-variant-option[data-variant="4k"]'));
  same(facts(), [[false, '12 episodes'], [false, '12 episodes'], [false, '6 episodes']]);
  h.Sheet.close();
  await pending;
});

// ------------------------------------------------------------------ combined review (phase 3)

test('Seerr mode: no "Pick episodes…" (Seerr takes whole seasons); "Just new episodes from now on" asks to keep getting them', async t => {
  const h = setup(t, { me: { ...MEMBER, backend: 'seerr' } });
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  const cards = [...h.document.querySelectorAll('.je-sheet-card')].map(c => c.dataset.choice);
  assert.deepEqual(cards, ['everything', 'latest', 'next', 'pick', 'future']);
  click(h, card(h, 'future'));
  click(h, primary(h));
  await settle(20);
  same(h.posts.at(-1).body.input, { key: 'tv:tvdb:393199', scope: 'future', variant: 'standard', seasons: [3], episodes: [] });
  await pending;
});

test('per-kind capabilities: a TV-only Seerr account gets the series sheet and controls but no movie asks', async t => {
  const h = setup(t, { me: { ...MEMBER, backend: 'seerr', canRequestMovies: false, canRequestSeries: true }, html: '<div id="m"></div><div id="s"></div>' });
  assert.equal(await h.Sheet.openOrAsk(MOVIE, { operation: h.NATIVE }), null);
  assert.equal(h.posts.length, 0);
  assert.deepEqual(h.toasts, ["You can't ask for this one."]);
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  assert.ok(sheetEl(h), 'the series sheet opens');
  key(h, 'Escape');
  await pending;
  const movie = h.Sheet.mount(h.document.getElementById('m'), MOVIE);
  const series = h.Sheet.mount(h.document.getElementById('s'), SERIES);
  await settle();
  assert.equal(h.document.querySelector('#m .je-ask-mount-request'), null);
  assert.ok(h.document.querySelector('#s .je-ask-mount-request'));
  movie.destroy();
  series.destroy();
  // A movies-only account: the other way round.
  h.state.me = { ...MEMBER, backend: 'seerr', canRequestMovies: true, canRequestSeries: false };
  h.JE.arrAsk.me(true);
  await settle();
  assert.equal(await h.Sheet.open(SERIES, { operation: h.NATIVE }), null);
  assert.equal((await h.Sheet.openOrAsk(MOVIE, { operation: h.NATIVE })).state, 'asked');
});

test('after an ask redraws the control that opened the sheet, focus goes to its replacement, else to its card', async t => {
  const h = setup(t, { html: '<div class="card" tabindex="-1" id="card"><div class="actions"><button id="opener" data-je-focus="discover:request:tv:tvdb:393199">Request</button></div></div>' });
  const actions = h.document.querySelector('.actions');
  // The page redraws its buttons while the ask is out (as Discover cards do on the ask event).
  let replace = true;
  h.state.answer = () => {
    actions.replaceChildren();
    if (replace) {
      const again = h.document.createElement('button');
      again.id = 'again';
      again.dataset.jeFocus = 'discover:request:tv:tvdb:393199';
      actions.appendChild(again);
    }
    return { status: 201, body: { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded' } };
  };
  let opener = h.document.getElementById('opener');
  opener.focus();
  let pending = h.Sheet.open(SERIES, { opener , operation: h.NATIVE });
  await settle();
  click(h, primary(h));
  await pending;
  assert.equal(h.document.activeElement.id, 'again', 'the redrawn control with the same focus id');

  // Nothing like it is drawn again: the card it was on keeps the focus.
  replace = false;
  opener = h.document.getElementById('again');
  opener.focus();
  pending = h.Sheet.open(SERIES, { opener , operation: h.NATIVE });
  await settle();
  click(h, primary(h));
  await pending;
  assert.equal(h.document.activeElement.id, 'card');
});

test('request outcomes are read out through one persistent live region that outlives the sheet', async t => {
  const h = setup(t);
  await h.Sheet.openOrAsk(MOVIE, { operation: h.NATIVE });
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  click(h, primary(h));
  await pending;
  assert.equal(sheetEl(h), null);
  const live = h.document.querySelectorAll('.je-ask-live');
  assert.equal(live.length, 1, 'one region for every outcome');
  assert.equal(live[0].getAttribute('role'), 'status');
  assert.equal(live[0].getAttribute('aria-live'), 'polite');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(live[0].textContent, "Asked! We'll let you know.");
});

// ------------------------------------------------------------------ phase 3g: storage full is said, not swallowed

const FULL = { reason: 'low_disk' };
const FULL_ADMIN = { reason: 'low_disk', instance: 'Sonarr', folder: '/tv/Severance', free: 2e9, freePercent: 0, limitPercent: 10 };
const PAUSED_TEXT = "There's no room for new downloads right now, so asking is paused. Dad can free up some space.";
/** A route answering the title check (GET acquire/requests/check) with `blocked`, and recording the keys asked. */
function checkRoute(blocked, seen) {
  return (method, path) => {
    if (method !== 'GET' || !path.startsWith('/acquire/requests/check')) return null;
    seen?.push(path);
    return { body: { outcome: 'accepted', reason: 'check', check: { key: 'x', variant: 'standard', canRequest: !blocked, blocked } } };
  };
}

test('storage full on the series page: the asks give way to "Paused: storage full" and a plain sentence; More… stays', async t => {
  const seen = [];
  const h = setup(t, { html: PAGE, hash: '#/details?id=series1', routes: checkRoute(FULL, seen) });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, { contact: 'Dad' });
  await settle(20);
  const box = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
  same([...box.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['More…']);
  assert.equal(box.querySelector('.je-ask-action-cost'), null, 'no cost line for asks that can\'t be made');
  same([box.querySelector('.je-ask-paused-title').textContent, box.querySelector('.je-ask-paused-text').textContent], ['Paused: storage full', PAUSED_TEXT]);
  assert.doesNotMatch(box.textContent, ARR_WORDS);
  same(seen, ['/acquire/requests/check?key=tv%3Atvdb%3A371980&variant=standard']);
  // Read once per title for a while: the next status read draws the same box from it.
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, { contact: 'Dad' });
  await settle(20);
  assert.equal(seen.length, 1);
  same(h.posts, []);
});

test('storage full on an episode page: an administrator keeps Search and is told where and how much is free; a Member gets the plain line', async t => {
  const seen = [];
  const admin = setup(t, {
    html: PAGE, hash: '#/details?id=e5', me: ADMIN, config: { ArrManageDrawerEnabled: true },
    routes: (method, path) => (method === 'POST' && path === '/arr/admin/manage/search' ? { body: { status: 'Succeeded', found: false } } : checkRoute(FULL_ADMIN, seen)(method, path))
  });
  const page = admin.document.getElementById('itemDetailPage');
  admin.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, admin: ADMIN_BLOCK }, {});
  await settle(20);
  // An administrator's Search isn't an ask, so it stays; the title is checked all the same and the line says where
  // and how much is free (the grab may not fit).
  same([...page.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['Search']);
  assert.equal(seen.length, 1);
  assert.equal(page.querySelector('.je-ask-paused-note .je-ask-paused-text').textContent, 'Sonarr: /tv/Severance has 2 GB free (0%), under the 10% low-disk limit. Requests are paused; Search still runs for you.');
  click(admin, page.querySelector('.je-ask-action'));
  await settle(20);
  same(admin.posts.map(p => p.path), ['/arr/admin/manage/search']);

  // An administrator's Get it on an episode that isn't monitored is an ask: paused, with the detail.
  const adminAsk = setup(t, { html: PAGE, hash: '#/details?id=e6', me: ADMIN, config: { ArrManageDrawerEnabled: true }, routes: checkRoute(FULL_ADMIN) });
  const page2 = adminAsk.document.getElementById('itemDetailPage');
  adminAsk.JE.internals.arrAskActions.attachDetails(page2, { key: 'tv:tvdb:371980:s3:e6', itemId: 'e6', kind: 'episode', stage: 'notHere', reason: { code: 'unmonitored' }, admin: ADMIN_BLOCK }, {});
  await settle(20);
  assert.equal(page2.querySelector('.je-ask-action'), null);
  assert.equal(page2.querySelector('.je-ask-paused-text').textContent, 'Sonarr: /tv/Severance has 2 GB free (0%), under the 10% low-disk limit. Requests are paused; Search still runs for you.');

  // A Member's Search of the same long-missing episode would be an ask (or a search the import couldn't follow): paused.
  const member = setup(t, { html: PAGE, hash: '#/details?id=e5', routes: checkRoute(FULL) });
  const page3 = member.document.getElementById('itemDetailPage');
  member.JE.internals.arrAskActions.attachDetails(page3, LONG_MISSING_EPISODE, {});
  await settle(20);
  assert.equal(page3.querySelector('.je-ask-action'), null);
  assert.equal(page3.querySelector('.je-ask-paused-text').textContent, PAUSED_TEXT);
  same([member.posts, member.searches], [[], []]);
});

test('storage full on the native page of a title that isn\'t in the library: checked by the page\'s keys, Get Season N gives way to the paused line, said once on a season page', async t => {
  const SERIES_PAGE = '4a45ad120001479b00000000c8f267bc';
  const SEASON_PAGE = '4a45ad130001479b0001000092805890';
  const absent = {
    key: 'tv:tmdb:83867', itemId: SERIES_PAGE, kind: 'series', stage: 'notHere', reason: { code: 'not_in_arr' },
    seasons: [{ season: 1, itemId: SEASON_PAGE, stage: 'notHere', summary: { aired: 12, ready: 0 } }]
  };
  const season = { key: 'tv:tmdb:83867:s1', itemId: SEASON_PAGE, kind: 'season', stage: 'notHere', reason: { code: 'not_in_arr' }, summary: { aired: 12, ready: 0 }, episodes: [] };
  for (const [me, blocked, text] of [[MEMBER, FULL, PAUSED_TEXT], [ADMIN, { ...FULL_ADMIN, folder: '/tv' }, 'Sonarr: /tv has 2 GB free (0%), under the 10% low-disk limit. Requests are paused; Search still runs for you.']]) {
    const seen = [];
    const h = setup(t, { html: PAGE, hash: `#/details?id=${SERIES_PAGE}`, me, routes: checkRoute(blocked, seen) });
    h.JE.titleDetails = { isSynthetic: id => String(id || '').startsWith('4a45ad1') };
    const page = h.document.getElementById('itemDetailPage');
    h.JE.internals.arrAskActions.attachDetails(page, absent, { contact: 'Dad' });
    await settle(20);
    let box = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
    // Request (the title's More…) stays: the sheet it opens says why in full.
    same([...box.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['Request']);
    same([box.querySelector('.je-ask-paused-title').textContent, box.querySelector('.je-ask-paused-text').textContent], ['Paused: storage full', text]);
    if (me === MEMBER) assert.doesNotMatch(box.textContent, ARR_WORDS);
    // Its season page: Get Season N gives way, and the season's rows (or Missing banner) say why right below, so
    // the box doesn't say it a second time.
    h.JE.internals.arrAskActions.attachDetails(page, season, { contact: 'Dad' });
    await settle(20);
    assert.equal(page.querySelector('.je-ask-actions[data-je-ask-surface="details"]'), null);
    assert.equal(page.querySelector('.je-ask-paused-note'), null);
    same(seen, ['/acquire/requests/check?key=tv%3Atmdb%3A83867&variant=standard', '/acquire/requests/check?key=tv%3Atmdb%3A83867%3As1&variant=standard']);
    same(h.posts, []);
  }
});

test('a title that can be asked for keeps its buttons; a check that can\'t be read changes nothing', async t => {
  const h = setup(t, { html: PAGE, hash: '#/details?id=series1', routes: checkRoute(null) });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, { contact: 'Dad' });
  await settle(20);
  same([...page.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['Get Season 2', 'Get missing episodes', 'More…']);
  assert.equal(page.querySelector('.je-ask-paused-note'), null);
  // The default harness answers 404 for the check: as before.
  const old = setup(t, { html: PAGE, hash: '#/details?id=series1' });
  const page2 = old.document.getElementById('itemDetailPage');
  old.JE.internals.arrAskActions.attachDetails(page2, SERIES_STATUS, { contact: 'Dad' });
  await settle(20);
  same([...page2.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['Get Season 2', 'Get missing episodes', 'More…']);
});

test('storage full in the sheet: said before anything is picked, no Request, no costs; the 4K copy is checked on its own', async t => {
  const seen = [];
  let blocked4k = null;
  const h = setup(t, {
    me: { ...MEMBER, can4kSeries: true },
    routes: (method, path) => (path.includes('variant=4k') ? checkRoute(blocked4k, seen)(method, path) : checkRoute(FULL, seen)(method, path))
  });
  const opening = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle(20);
  const note = h.document.querySelector('.je-sheet-note');
  assert.ok(note.classList.contains('je-sheet-note-paused'));
  assert.equal(note.textContent, `storagePaused: storage full · ${PAUSED_TEXT}`);
  // Read out with the dialog's name whatever gets the focus (the reason is plain text).
  const dialog = h.document.querySelector('.je-sheet');
  assert.ok(note.id);
  assert.equal(dialog.getAttribute('aria-describedby'), note.id);
  assert.ok(primary(h).hidden, 'nothing to send');
  assert.match(h.document.querySelector('style#je-ask-sheet-styles, style')?.textContent || '', /\.je-sheet-primary\[hidden\]\s*\{\s*display:\s*none/);
  assert.equal(h.document.querySelector('.je-sheet-secondary').textContent, 'Close');
  assert.ok([...h.document.querySelectorAll('.je-sheet-card-cost')].every(c => c.hidden), 'no costs for asks that can\'t be made');
  // The 4K copy goes to another instance (another drive): checked when chosen, and it can be asked for.
  click(h, h.document.querySelector('.je-sheet-variant-option[data-variant="4k"]'));
  await settle(20);
  same(seen.map(p => p.split('variant=')[1]), ['standard', '4k']);
  assert.ok(!primary(h).hidden);
  assert.ok(!h.document.querySelector('.je-sheet-note').classList.contains('je-sheet-note-paused'));
  assert.equal(dialog.getAttribute('aria-describedby'), null, 'nothing paused to read out');
  key(h, 'Escape');
  assert.equal(await opening, null);
  same(h.posts, []);
});

test('storage full on a collection page: each movie the server marks is left out of the batch and said, the rest are asked for; the household\'s new-add pause decides nothing', async t => {
  const marked = (keys, block) => ({ ...GAPS, missing: GAPS.missing.map(p => keys.includes(p.key) ? { ...p, blocked: block } : p) });
  let gaps = marked(['movie:tmdb:12'], FULL);
  const h = setup(t, {
    // The household pause (default root full) is on; only the server's per-movie answer counts.
    html: BOX_PAGE, hash: '#/details?id=box1', item: { Id: 'box1', Type: 'BoxSet' }, me: { ...MEMBER, pausedMovies: FULL },
    routes: (method, path) => path.startsWith('/acquire/requests/collection/box1') ? { body: { outcome: 'accepted', reason: 'collection', collection: gaps } } : null,
    answer: (input) => (input.key === 'movie:tmdb:13'
      // Its drive filled up after the page was drawn: refused for storage, said as such.
      ? { status: 403, body: { outcome: 'blocked', reason: 'low_disk', certainty: 'Succeeded' } }
      : { status: 201, body: { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded' } })
  });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, null);
  await settle(20);
  let block = page.querySelector('.je-ask-coll');
  assert.equal(block.querySelector('.je-ask-coll-get').textContent, 'downloadGet the 2 missing');
  same([...block.querySelectorAll('.je-ask-paused-note')].map(n => [n.querySelector('.je-ask-paused-title').textContent, n.querySelector('.je-ask-paused-text').textContent]), [['Paused: storage full', PAUSED_TEXT]]);
  same([...block.querySelectorAll('.je-ask-coll-part')].map(li => li.textContent), ['Part Five (2008)', 'Part Six (2011)Paused: storage full', 'Part Seven (2012)', 'Part Eight (2031)Not out yet']);
  click(h, block.querySelector('.je-ask-coll-get'));
  await settle(60);
  same(h.posts.map(p => p.body.input.key), ['movie:tmdb:11', 'movie:tmdb:13'], 'the paused movie is not asked for');
  same(h.toasts, ['Asked for 1 · 1 paused: storage full']);

  // Every movie paused: the line takes the button's place (once, however many movies).
  gaps = marked(['movie:tmdb:11', 'movie:tmdb:12', 'movie:tmdb:13'], FULL);
  h.JE.internals.arrAskActions.attachDetails(page, null);
  await settle(20);
  block = page.querySelector('.je-ask-coll');
  assert.equal(block.querySelector('.je-ask-coll-get'), null);
  assert.equal(block.querySelectorAll('.je-ask-paused-note').length, 1);
  assert.match(block.querySelector('.je-ask-coll-have').textContent, /You have 4 of 7\./);
  assert.equal(block.querySelectorAll('.je-ask-coll-part').length, 4, 'the missing movies are still listed');

  // Nothing marked (e.g. the missing movies Radarr has sit on a roomy drive): Get the 3 missing as usual.
  gaps = GAPS;
  h.JE.internals.arrAskActions.attachDetails(page, null);
  await settle(20);
  block = page.querySelector('.je-ask-coll');
  assert.equal(block.querySelector('.je-ask-coll-get').textContent, 'downloadGet the 3 missing');
  assert.equal(block.querySelector('.je-ask-paused-note'), null);

  // An administrator reads one line per drive, with where and how much is free.
  const other = { ...FULL_ADMIN, instance: 'Radarr', folder: '/movies2/Part Seven', free: 3e9 };
  const admin = setup(t, {
    html: BOX_PAGE, hash: '#/details?id=box1', item: { Id: 'box1', Type: 'BoxSet' }, me: ADMIN,
    routes: (method, path) => path.startsWith('/acquire/requests/collection/box1')
      ? { body: { outcome: 'accepted', reason: 'collection', collection: { ...GAPS, missing: GAPS.missing.map(p => p.key === 'movie:tmdb:13' ? { ...p, blocked: other } : p.key === 'movie:tmdb:12' ? { ...p, blocked: { ...FULL_ADMIN, instance: 'Radarr', folder: '/movies' } } : p) } } }
      : null
  });
  const page2 = admin.document.getElementById('itemDetailPage');
  admin.JE.internals.arrAskActions.attachDetails(page2, null);
  await settle(20);
  same([...page2.querySelectorAll('.je-ask-paused-text')].map(n => n.textContent), [
    'Radarr: /movies has 2 GB free (0%), under the 10% low-disk limit. Requests are paused; Search still runs for you.',
    'Radarr: /movies2/Part Seven has 3 GB free (0%), under the 10% low-disk limit. Requests are paused; Search still runs for you.'
  ]);
  assert.equal(page2.querySelector('.je-ask-coll-get').textContent, 'downloadGet the missing one');

  // Watchers can't ask: no paused line either.
  const watcher = setup(t, {
    html: BOX_PAGE, hash: '#/details?id=box1', item: { Id: 'box1', Type: 'BoxSet' }, me: WATCHER,
    routes: (method, path) => path.startsWith('/acquire/requests/collection/box1') ? { body: { outcome: 'accepted', reason: 'collection', collection: marked(['movie:tmdb:12'], FULL) } } : null
  });
  const page3 = watcher.document.getElementById('itemDetailPage');
  watcher.JE.internals.arrAskActions.attachDetails(page3, null);
  await settle(20);
  assert.equal(page3.querySelector('.je-ask-paused-note'), null);
  assert.doesNotMatch(page3.querySelector('.je-ask-coll')?.textContent || '', /Paused/);
});

test('mount API: the title is checked; one that can\'t be asked for reads "Paused: storage full" and opens the sheet, which says why; the household\'s new-add pause decides nothing', async t => {
  const seen = [];
  const h = setup(t, { html: '<div id="m"></div>', me: MEMBER, routes: checkRoute(FULL, seen) });
  const m = h.document.getElementById('m');
  const controls = h.Sheet.mount(m, MOVIE);
  await settle();
  controls.update({ key: MOVIE.key, kind: 'movie', stage: 'notHere', reason: { code: 'not_in_arr' } });
  await settle(20);
  const paused = m.querySelector('.je-ask-mount-paused');
  assert.equal(paused.tagName, 'BUTTON', 'touch, keyboard and D-pad reach it');
  assert.equal(paused.textContent, 'storagePaused: storage full');
  assert.equal(paused.getAttribute('aria-label'), `Paused: storage full. ${PAUSED_TEXT}`);
  click(h, paused);
  await settle(20);
  // The sheet (not a one-tap ask) says why in full; the title's check is read once.
  same(seen, ['/acquire/requests/check?key=movie%3Atmdb%3A1084242&variant=standard']);
  assert.match(h.document.querySelector('.je-sheet-note-paused').textContent, /Paused: storage full · There's no room/);
  same(h.posts, []);
  controls.destroy();

  // New titles are paused (default root full) but this one can be asked for (e.g. held on a roomy drive): Request.
  const roomy = setup(t, { html: '<div id="m"></div>', me: { ...MEMBER, pausedMovies: FULL }, routes: checkRoute(null) });
  const mr = roomy.document.getElementById('m');
  const cr = roomy.Sheet.mount(mr, MOVIE);
  await settle();
  cr.update({ key: MOVIE.key, kind: 'movie', stage: 'notHere', reason: { code: 'not_in_arr' } });
  await settle(20);
  assert.equal(mr.querySelector('.je-ask-mount-paused'), null);
  assert.equal(mr.querySelector('.je-ask-mount-request').textContent, 'addRequest');
  cr.destroy();
});

test('mount API, storage full on a title missing for a long while: an administrator keeps Search with where and how much is free; a family Search gives way to the plain line', async t => {
  const LOOKING = { key: MOVIE.key, kind: 'movie', stage: 'looking', reason: { code: 'no_release_yet' } };
  const admin = setup(t, {
    html: '<div id="m"></div>', me: ADMIN, config: { ArrManageDrawerEnabled: true },
    routes: (method, path) => (method === 'POST' && path === '/arr/admin/manage/search' ? { body: { status: 'Succeeded', found: false } } : checkRoute(FULL_ADMIN)(method, path))
  });
  const m = admin.document.getElementById('m');
  const c = admin.Sheet.mount(m, MOVIE);
  await settle();
  c.update({ ...LOOKING, admin: { variants: [{ instance: 'Radarr', instanceId: 'rad1', kind: 'Radarr', role: 'standard', stage: 'looking', reason: { code: 'no_release_yet' }, fix: 'search_now' }] } });
  await settle(20);
  assert.ok(m.querySelector('.je-ask-mount-search'), 'an administrator\'s Search stays');
  assert.equal(m.querySelector('.je-ask-paused-note .je-ask-paused-text').textContent, 'Sonarr: /tv/Severance has 2 GB free (0%), under the 10% low-disk limit. Requests are paused; Search still runs for you.');
  click(admin, m.querySelector('.je-ask-mount-search'));
  await settle(20);
  same(admin.posts.map(p => p.path), ['/arr/admin/manage/search']);
  c.destroy();

  const member = setup(t, { html: '<div id="m"></div>', me: MEMBER, routes: checkRoute(FULL) });
  const m2 = member.document.getElementById('m');
  const c2 = member.Sheet.mount(m2, MOVIE);
  await settle();
  c2.update(LOOKING);
  await settle(20);
  assert.equal(m2.querySelector('.je-ask-mount-search, .je-ask-mount-request'), null, 'no Search that would be refused');
  same([m2.querySelector('.je-ask-paused-title').textContent, m2.querySelector('.je-ask-paused-text').textContent], ['Paused: storage full', PAUSED_TEXT]);
  same([member.posts, member.searches], [[], []]);
  c2.destroy();

  // Roomy: the family Search is offered as before.
  const ok = setup(t, { html: '<div id="m"></div>', me: MEMBER, routes: checkRoute(null) });
  const m3 = ok.document.getElementById('m');
  const c3 = ok.Sheet.mount(m3, MOVIE);
  await settle();
  c3.update(LOOKING);
  await settle(20);
  assert.ok(m3.querySelector('.je-ask-mount-search'));
  assert.equal(m3.querySelector('.je-ask-paused-note'), null);
  c3.destroy();
});

// ------------------------------------------------------------------ Seerr mode: Seerr takes whole seasons

const SEERR_MEMBER = { ...MEMBER, backend: 'seerr' };

test('Seerr mode: an episode page offers its season by name with the reason, and asks for the season', async t => {
  const h = setup(t, { html: PAGE, hash: '#/details?id=e5', me: SEERR_MEMBER });
  const page = h.document.getElementById('itemDetailPage');
  // Not being fetched (unmonitored): Get it, as its season. (One Sonarr is looking for right now offers nothing.)
  h.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, stage: 'notHere', reason: { code: 'unmonitored' } }, {});
  await settle();
  const box = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
  assert.deepEqual([...box.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['Get Season 3']);
  assert.equal(box.querySelector('.je-ask-action-note').textContent, 'Seerr takes whole seasons, so this asks for all of Season 3.');
  click(h, box.querySelector('.je-ask-action'));
  await settle(20);
  same(h.posts.map(p => p.body.input), [{ key: 'tv:tvdb:371980', scope: 'seasons', variant: 'standard', seasons: [3], episodes: [] }]);
  // A Kid's reads "Ask Dad for Season 3"; long missing with nothing sent for it yet (a Search would ask), the same.
  h.state.me = { ...SEERR_MEMBER, role: 'kid', asksFirst: true };
  await h.JE.arrAsk.me(true);
  // (Season 3 was just asked for: its episodes show that instead.)
  h.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, key: 'tv:tvdb:371980:s3:e6' }, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-actions .je-arr-chip').textContent, 'Asked!');
  h.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, key: 'tv:tvdb:371980:s4:e6' }, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-action .je-ask-action-text').textContent, 'Ask Dad for Season 4');
  // A request already went out for it: Search searches again (no ask, no rounding).
  h.JE.internals.arrAskActions.attachDetails(page, { ...LONG_MISSING_EPISODE, key: 'tv:tvdb:371980:s3:e7', reason: { code: 'no_release_yet', params: { sent: '1' } } }, {});
  await settle();
  assert.equal(page.querySelector('.je-ask-action .je-ask-action-text').textContent, 'Search');
  assert.equal(page.querySelector('.je-ask-action-note'), null);
});

test('Seerr mode: the series page\'s "Get missing episodes" names the seasons it asks for', async t => {
  const h = setup(t, { html: PAGE, hash: '#/details?id=series1', me: SEERR_MEMBER, quota: { used: 2, limit: null, remaining: null, available: true } });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, { contact: 'Dad' });
  await settle();
  const box = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
  assert.deepEqual([...box.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['Get Season 2', 'Get Season 3', 'More…']);
  assert.equal(box.querySelector('.je-ask-action-note').textContent, 'Seerr takes whole seasons, so this asks for all of Season 3.');
  click(h, box.querySelectorAll('.je-ask-action')[1]);
  await settle(20);
  same(h.posts.map(p => p.body.input), [{ key: 'tv:tvdb:371980', scope: 'seasons', variant: 'standard', seasons: [3], episodes: [] }]);
  assert.ok(!h.statusCalls.some(p => p.includes('/acquire/status/item/s3')), 'no episode reads: the season is asked for');
});

test('Seerr with partial requests off: one "Get the whole series" on the series page, one whole-series card in the sheet', async t => {
  const h = setup(t, { html: PAGE, hash: '#/details?id=series1', me: { ...SEERR_MEMBER, seerrWholeSeries: true } });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrAskActions.attachDetails(page, SERIES_STATUS, { contact: 'Dad' });
  await settle();
  const box = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
  assert.deepEqual([...box.querySelectorAll('.je-ask-action-text')].map(n => n.textContent), ['Get the whole series', 'More…']);
  assert.equal(box.querySelector('.je-ask-action-note').textContent, 'Seerr takes whole series only, so this asks for every season.');
  click(h, box.querySelector('.je-ask-action'));
  await settle(20);
  same(h.posts.map(p => p.body.input), [{ key: 'tv:tvdb:371980', scope: 'seasons', variant: 'standard', seasons: [1, 2, 3], episodes: [] }]);
  const pending = h.Sheet.open(SERIES, { operation: h.NATIVE });
  await settle();
  assert.deepEqual([...h.document.querySelectorAll('.je-sheet-card')].map(c => c.dataset.choice), ['everything']);
  assert.match(card(h, 'everything').textContent, /The whole series \(3 seasons\)/);
  click(h, card(h, 'everything'));
  click(h, primary(h));
  await settle(20);
  same(h.posts.at(-1).body.input.seasons, [1, 2, 3]);
  await pending;
});

test('provider season entry starts with exactly that season selected', async t => {
  const h = setup(t); h.Sheet.open({ ...SERIES, initialSeason: 2 }, { operation: h.NATIVE }); await settle();
  assert.equal(card(h, 'pick').getAttribute('aria-pressed'), 'true');
  click(h, primary(h)); await settle();
  assert.deepEqual([...h.posts[0].body.input.seasons], [2]);
});

test('provider episode entry starts with exactly that episode selected', async t => {
  const h = setup(t); h.Sheet.open({ ...SERIES, initialSeason: 2, initialEpisode: 4 }, { operation: h.NATIVE }); await settle();
  assert.equal(card(h, 'episodes').getAttribute('aria-pressed'), 'true');
  click(h, primary(h)); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(h.posts[0].body.input.episodes)), [{ season: 2, episode: 4 }]);
});
