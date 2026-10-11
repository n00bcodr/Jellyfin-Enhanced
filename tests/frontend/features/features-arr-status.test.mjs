// Requests & downloads, phase 1: the status pill, journey, admin lines, series/season summaries,
// episode chips + banner and poster badges, rendered by the real modules from server responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, jsRoot } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = ['arr/status/status-core.js', 'arr/status/status-episodes.js', 'arr/status/status-details.js', 'arr/status/status-cards.js', 'arr/status/status-styles.js'];

/** JE.t as the real one behaves: the English string with {name} parameters filled in. */
function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

function setup(t, { html = '', hash = '#/home', config = {}, responses = () => null } = {}) {
  const calls = [];
  const navigation = [];
  const bodyObservers = [];
  const observers = [];
  const userChange = [];
  const h = createHarness({
    html,
    url: `http://jellyfin.test/web/index.html${hash}`,
    globals: {
      IntersectionObserver: class {
        constructor(fn) { this.fn = fn; this.observed = new Set(); observers.push(this); }
        observe(el) { this.observed.add(el); }
        unobserve(el) { this.observed.delete(el); }
        disconnect() { this.observed.clear(); }
      }
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrStatusPosterBadges: true, ...config },
      t: translate,
      helpers: {
        debounce: fn => fn,
        addCSS: (id, css) => { const s = h.document.createElement('style'); s.id = id; s.textContent = css; h.document.head.appendChild(s); },
        onBodyMutation: (id, fn) => { bodyObservers.push(fn); return { unsubscribe() {} }; }
      },
      core: {
        api: {
          plugin: async (path, options) => {
            calls.push({ path, options });
            const answer = responses(path, calls.length);
            if (answer instanceof Error) throw answer;
            return answer;
          }
        },
        navigation: { onNavigate: fn => { navigation.push(fn); return () => {}; }, onViewPage: fn => { navigation.push(fn); return () => {}; } },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: (k, fn) => userChange.push(fn) }
    }
  });
  t.after(() => h.close());
  for (const m of MODULES) h.load(m);
  return {
    ...h, calls, navigation, observers, userChange,
    S: h.JE.arrStatus,
    mutate() { for (const fn of bodyObservers) fn([{ addedNodes: [1] }]); }
  };
}

const ctx = { contact: 'Dad', lookingHours: 24 };
/** deepEqual across the jsdom realm (its arrays are not this realm's). */
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const iso = days => new Date(Date.now() + days * 86400000).toISOString();

test('every reason code reads as a plain family sentence from en.json', t => {
  const h = setup(t);
  const text = (code, extra = {}) => h.S.familyText({ stage: 'x', reason: { code, params: extra.params }, progress: extra.progress }, ctx);
  assert.equal(text('downloading', { progress: { percent: 42, etaSeconds: 720 } }), 'Downloading · 42% · about 12 min');
  assert.equal(text('downloading', { progress: { percent: 42 } }), 'Downloading · 42%');
  assert.equal(text('queued'), 'Waiting in line');
  assert.equal(text('delay_held'), 'Waiting in line');
  assert.equal(text('looking'), 'Looking for it');
  assert.equal(text('no_release_yet'), "Still looking, we'll keep trying");
  assert.match(text('not_released', { params: { date: iso(40) } }), /^Not out yet, expected /);
  assert.match(text('in_cinemas', { params: { date: iso(40) } }), /^In cinemas; at home around /);
  assert.equal(text('not_aired', { params: { date: iso(1) } }), 'Airs tomorrow');
  assert.equal(text('importing'), 'Almost ready');
  assert.equal(text('library_pending'), 'Almost ready');
  assert.equal(text('import_blocked'), 'Taking longer than usual');
  assert.equal(text('stalled'), "Download is slow, we're on it");
  assert.equal(text('failed'), "That copy didn't work, finding another");
  assert.equal(text('awaiting_approval'), 'Waiting for Dad to OK it');
  assert.equal(h.S.familyText({ reason: { code: 'awaiting_approval' } }, {}), 'Waiting for the admin to OK it');
  assert.equal(text('not_visible_to_user'), 'Not in the library');
  assert.equal(text('ready'), 'Ready to watch');
  assert.equal(text('upgrading'), 'Ready · a better copy is coming');
});

test('every key the status modules use, and every admin/fix text a server code can ask for, exists in en.json', () => {
  const source = MODULES.map(m => readFileSync(resolve(jsRoot, m), 'utf8')).join('\n');
  for (const [, key] of source.matchAll(/tr\('([a-z0-9_]+)'/g)) assert.ok(key in en, key);
  for (const [, key] of source.matchAll(/'(arr_journey_[a-z_]+)'/g)) assert.ok(key in en, key);
  const cs = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Services/Acquire/TitleStatus.cs'), 'utf8');
  const block = name => cs.slice(cs.indexOf(`public static class ${name}`), cs.indexOf('}', cs.indexOf(`public static class ${name}`)));
  const values = name => [...block(name).matchAll(/public const string \w+ = "([a-z_]+)";/g)].map(m => m[1]);
  const handled = new Set(['downloading', 'ready', 'upgrading']);
  for (const code of values('StatusReasonCode')) if (!handled.has(code)) assert.ok(`arr_admin_${code}` in en, `arr_admin_${code}`);
  for (const fix of values('StatusFix')) assert.ok(`arr_fix_${fix}` in en, `arr_fix_${fix}`);
  assert.ok(values('StatusFix').length >= 10);
});

test('the pill has an icon, words and a progress bar; the journey opens on tap; nothing is parsed as HTML', t => {
  const h = setup(t);
  const status = {
    key: 'movie:tmdb:693134', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 42, etaSeconds: 720 },
    journey: [
      { stage: 'asked', at: iso(-1), state: 'done', byYou: false }, { stage: 'approved', at: iso(-1), state: 'done' },
      { stage: 'downloading', state: 'current' }, { stage: 'almostReady', state: 'next' }, { stage: 'ready', state: 'next' }
    ]
  };
  const block = h.S.buildPill(status, ctx);
  const pill = block.querySelector('button.je-arr-pill');
  assert.equal(block.dataset.jeArrKey, 'movie:tmdb:693134');
  assert.equal(pill.querySelector('.je-arr-pill-text').textContent, 'Downloading · 42% · about 12 min');
  assert.ok(pill.classList.contains('je-arr-tone-downloading'));
  assert.equal(pill.querySelector('.je-arr-pill-icon').textContent, 'download');
  assert.equal(block.querySelector('[role=progressbar]').getAttribute('aria-valuenow'), '42');
  const journey = block.querySelector('.je-arr-journey');
  assert.equal(journey.hidden, true);
  pill.click();
  assert.equal(journey.hidden, false);
  assert.equal(pill.getAttribute('aria-expanded'), 'true');
  same([...journey.querySelectorAll('.je-arr-stop-label')].map(e => e.textContent), ['Asked by someone in your household', "OK'd", 'Downloading', 'Almost ready', 'Ready']);
  assert.equal(journey.querySelector('.je-arr-stop-current .je-arr-stop-date').textContent, 'now');
  assert.equal(block.querySelector('.je-arr-admin'), null, 'no admin block without admin data');

  const evil = '<img src=x onerror="alert(1)">';
  const blocked = h.S.buildPill({ key: 'k', stage: 'asked', reason: { code: 'awaiting_approval' } }, { contact: evil });
  assert.equal(blocked.querySelector('img'), null);
  assert.ok(blocked.textContent.includes(evil));
  assert.equal(blocked.querySelector('button'), null, 'no journey: the pill is not a button');
});

test('admin lines name the instance, the arr words and the fix; a single ready copy says nothing', t => {
  const h = setup(t);
  const evil = '<b>boom</b>';
  const status = {
    key: 'k', kind: 'episode', stage: 'almostReady', attention: true, reason: { code: 'import_blocked' },
    admin: { variants: [
      { instance: 'Sonarr (rig)', kind: 'Sonarr', stage: 'almostReady', attention: true, reason: { code: 'import_blocked' }, messages: [evil], fix: 'manual_import', client: 'Mock SABnzbd', quality: 'Bluray-1080p', customFormatScore: 100, since: new Date(Date.now() - 41 * 60000).toISOString() }
    ], unreadable: ['Radarr 4K (rig) (Unreachable)'] }
  };
  const block = h.S.buildPill(status, ctx);
  const lines = [...block.querySelectorAll('.je-arr-admin-line')];
  assert.equal(lines.length, 2);
  assert.equal(lines[0].querySelector('.je-arr-admin-text').textContent, 'Sonarr (rig) · Import blocked · for 41 min · Mock SABnzbd · Bluray-1080p · CF 100');
  assert.equal(lines[0].querySelector('.je-arr-admin-detail').textContent, evil);
  assert.equal(lines[0].querySelector('b'), null);
  assert.equal(lines[0].querySelector('.je-arr-admin-fix').textContent, 'Fix: import it manually in Sonarr (rig)');
  assert.equal(lines[1].querySelector('.je-arr-admin-text').textContent, "Radarr 4K (rig) (Unreachable) can't be read");
  assert.ok(block.querySelector('.je-arr-pill').classList.contains('je-arr-tone-attention'));
  assert.equal(block.querySelector('.je-arr-pill-icon').textContent, 'schedule');

  const quiet = h.S.adminLines({ admin: { variants: [{ instance: 'Radarr', stage: 'ready', reason: { code: 'ready' } }] } });
  same(quiet, []);
  const two = h.S.adminLines({ admin: { variants: [
    { instance: 'Radarr', stage: 'ready', reason: { code: 'ready' }, library: 'Movies' },
    { instance: 'Radarr 4K', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 42 } }
  ] } });
  same(two.map(l => l.text), ['Radarr · In Movies', 'Radarr 4K · Downloading 42%']);
});

test('series and season summaries read like "Seasons 1–2 ready · Season 3 airing (ep 6 …) · 1 downloading"', t => {
  const h = setup(t);
  const series = { key: 's', kind: 'series', summary: { readySeasons: [1, 2], nextAir: iso(1), nextSeason: 3, nextEpisode: 6, downloading: 1, missing: 0, attention: 0, almostReady: 0 } };
  same(h.S.summaryPieces(series).map(p => p.text), ['Seasons 1–2 ready', 'Season 3 airing (ep 6 tomorrow)', '1 downloading']);
  const starts = { kind: 'series', summary: { readySeasons: [1, 3], nextAir: iso(1), nextSeason: 4, nextEpisode: 1 } };
  same(h.S.summaryPieces(starts).map(p => p.text), ['Seasons 1, 3 ready', 'Season 4 starts tomorrow']);
  const season = { kind: 'season', summary: { aired: 10, ready: 8, downloading: 1, missing: 1, attention: 1, nextAir: iso(1), nextEpisode: 11 } };
  same(h.S.summaryPieces(season).map(p => p.text), ['8 of 10 ready', 'Episode 11 airs tomorrow', '1 downloading', '1 missing', '1 taking longer than usual']);
  const block = h.S.buildSummary({ ...season, key: 'tv:tvdb:1:s9' });
  assert.equal(block.querySelectorAll('.je-arr-pill-small').length, 5);
  assert.equal(h.S.buildSummary({ kind: 'season', summary: {} }), null);
});

const detailsHtml = '<div id="itemDetailPage" class="page libraryPage"><div class="detailPagePrimaryContent"><div class="detailSection"><form class="trackSelections"></form></div></div>'
  + '<div class="itemsContainer"><div class="listItem" data-type="Episode" data-id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1"><div class="listItemBody"><div class="listItemMediaInfo"></div></div></div>'
  + '<div class="listItem" data-type="Episode" data-id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3"><div class="listItemBody"><div class="listItemMediaInfo"></div></div></div></div></div>';

test('the details page gets one request, the pill under the title, and re-renders in place on a change', async t => {
  let percent = 42;
  const h = setup(t, {
    html: detailsHtml, hash: '#/details?id=movie1',
    responses: path => path.startsWith('/acquire/status/item/movie1')
      ? { contact: 'Dad', items: [{ key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent } }] }
      : null
  });
  await h.JE.internals.arrStatusDetails.update(false);
  const section = h.document.querySelector('.detailSection');
  assert.equal(section.firstElementChild.dataset.jeArrSurface, 'details');
  assert.match(section.textContent, /Downloading · 42%/);
  await h.JE.internals.arrStatusDetails.update(false);
  assert.equal(h.calls.length, 1, 'the same page is not fetched again');
  assert.equal(h.calls[0].options.priority, undefined, 'details are a normal-priority request');

  percent = 90;
  assert.equal(h.S.refresh(['movie:tmdb:1']), 1);
  await nextTurn();
  assert.equal(h.calls.length, 2);
  assert.equal(h.document.querySelectorAll('.je-arr-status').length, 1);
  assert.match(section.textContent, /Downloading · 90%/);
  assert.equal(h.S.refresh(['movie:tmdb:2']), 0, 'other titles do not refetch');
});

test('a quiet status draws nothing; a 403 switches the surfaces off for the page load', async t => {
  const h = setup(t, {
    html: detailsHtml, hash: '#/details?id=movie1',
    responses: (path, n) => n === 1 ? { items: [{ key: 'k', kind: 'movie', stage: 'ready', reason: { code: 'ready' }, quiet: true }] } : Object.assign(new Error('403'), { status: 403 })
  });
  await h.JE.internals.arrStatusDetails.update(false);
  assert.equal(h.document.querySelector('.je-arr-status'), null);
  await h.JE.internals.arrStatusDetails.update(true);
  assert.equal(h.S.enabled(), false);
  await h.JE.internals.arrStatusDetails.update(true);
  assert.equal(h.calls.length, 2, 'no request once disabled');
});

test('season pages: chips on the rows the viewer has, the others in the banner, never both', async t => {
  const season = {
    key: 'tv:tvdb:1:s1', kind: 'season', stage: 'downloading', reason: { code: 'downloading' },
    summary: { aired: 4, ready: 1, downloading: 1, missing: 1, almostReady: 1, attention: 0 },
    episodes: [
      { key: 'e1', season: 1, episode: 1, itemId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', row: true, stage: 'ready', reason: { code: 'ready' } },
      { key: 'e2', season: 1, episode: 2, row: false, stage: 'looking', reason: { code: 'no_release_yet' } },
      { key: 'e3', season: 1, episode: 3, itemId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3', row: true, stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 60 } },
      { key: 'e4', season: 1, episode: 4, row: false, stage: 'almostReady', reason: { code: 'library_pending' } },
      { key: 'e5', season: 1, episode: 5, row: false, stage: 'notOut', reason: { code: 'not_aired', params: { date: iso(1) } } },
      { key: 'e6', season: 1, episode: 6, row: false, stage: 'notOut', reason: { code: 'not_aired', params: { date: iso(8) } } }
    ]
  };
  const h = setup(t, { html: detailsHtml, hash: '#/details?id=season1', responses: () => ({ items: [season] }) });
  await h.JE.internals.arrStatusDetails.update(false);
  const rows = [...h.document.querySelectorAll('.listItem')];
  assert.equal(rows[0].querySelector('.je-arr-chip').textContent, 'Ready');
  assert.equal(rows[1].querySelector('.je-arr-chip').textContent, 'Downloading 60%');
  const banner = h.document.querySelector('.je-arr-banner');
  assert.equal(banner.querySelector('.je-arr-banner-title').textContent, 'Missing: E2');
  same([...banner.querySelectorAll('.je-arr-chip')].map(c => c.textContent), ['E4 · Almost ready', 'E5 · Airs tomorrow']);
  assert.ok(!/E3|E1|E6/.test(banner.textContent), 'rows and later airings are not repeated in the banner');
  assert.equal(banner.nextElementSibling.className, 'itemsContainer');
  assert.match(h.document.querySelector('.je-arr-summary').textContent, /1 of 4 ready/);

  // Jellyfin re-renders the rows: the chips come back.
  rows[1].querySelector('.je-arr-chip').remove();
  h.mutate();
  assert.equal(rows[1].querySelector('.je-arr-chip').textContent, 'Downloading 60%');
  // Phone layouts hide the media-info line: the chip goes on the thumbnail instead.
  const phone = h.document.createElement('div');
  phone.className = 'listItem';
  phone.setAttribute('data-type', 'Episode');
  phone.setAttribute('data-id', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1');
  phone.innerHTML = '<div class="listItemImage"></div><div class="listItemBody"><div class="listItemMediaInfo" style="display:none"></div></div>';
  rows[0].parentNode.appendChild(phone);
  h.JE.internals.arrStatusEpisodes.apply();
  assert.equal(phone.querySelector('.listItemImage > .je-arr-chip.je-arr-chip-overlay').textContent, 'Ready');
  assert.equal(phone.querySelector('.listItemMediaInfo .je-arr-chip'), null);
  // With the overview line under the row (jellyfin-web's phone layout) the chip gets its own line above it.
  phone.querySelector('.je-arr-chip').remove();
  phone.insertAdjacentHTML('beforeend', '<div class="listItem-bottomoverview"></div>');
  h.JE.internals.arrStatusEpisodes.apply();
  assert.equal(phone.querySelector('.je-arr-chip-row + .listItem-bottomoverview').previousElementSibling.textContent, 'Ready');
  assert.equal(phone.querySelectorAll('.je-arr-chip').length, 1);
  h.JE.internals.arrStatusEpisodes.apply();
  assert.equal(phone.querySelectorAll('.je-arr-chip-row').length, 1, 'idempotent');
  phone.remove();
  // A quiet season (all ready) shows no "Ready" chips.
  h.JE.internals.arrStatusEpisodes.render(h.document.querySelector('#itemDetailPage'), { ...season, quiet: true, episodes: [season.episodes[0]] }, {});
  assert.equal(rows[0].querySelector('.je-arr-chip'), null);
  assert.equal(h.document.querySelector('.je-arr-banner'), null);
});

function cardsHtml(n, type = 'Movie') {
  let html = '';
  for (let i = 0; i < n; i++) {
    const id = i.toString(16).padStart(32, '0');
    html += `<div class="card" data-id="${id}" data-type="${type}"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div></div></div>`;
  }
  return html + '<div class="card" data-id="ffffffffffffffffffffffffffffffff" data-type="BoxSet"><div class="cardScalable"></div></div>';
}

test('poster badges: only cards near the viewport are asked for, batched, and quiet ones draw nothing', async t => {
  const answers = new Map([
    ['00000000000000000000000000000000', { itemId: '00000000000000000000000000000000', key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 42 } }],
    ['00000000000000000000000000000001', { itemId: '00000000000000000000000000000001', key: 'movie:tmdb:2', kind: 'movie', stage: 'ready', reason: { code: 'ready' }, quiet: true }],
    ['00000000000000000000000000000002', { itemId: '00000000000000000000000000000002', key: 'movie:tmdb:3', kind: 'movie', stage: 'almostReady', reason: { code: 'importing' } }],
    ['00000000000000000000000000000003', { itemId: '00000000000000000000000000000003', key: 'movie:tmdb:4', kind: 'movie', stage: 'almostReady', attention: true, reason: { code: 'import_blocked' } }]
  ]);
  const h = setup(t, {
    html: cardsHtml(150),
    responses: path => {
      const ids = decodeURIComponent(/ids=([^&]*)/.exec(path)[1]).split(',');
      return { items: ids.filter(id => answers.has(id)).map(id => answers.get(id)) };
    }
  });
  h.JE.initializeArrStatus();
  h.JE.internals.arrStatusCards.scan();
  const io = h.observers[0];
  assert.equal(io.observed.size, 150, 'BoxSet cards are not watched');
  // 120 cards come into view at once: two batched requests (100 + 20), not one per card.
  io.fn([...io.observed].slice(0, 120).map(target => ({ isIntersecting: true, target })));
  await h.JE.internals.arrStatusCards.flush();
  await nextTurn();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].options.priority, 'low');
  assert.equal(decodeURIComponent(/ids=([^&]*)/.exec(h.calls[0].path)[1]).split(',').length, 100);
  const card = i => h.document.querySelectorAll('.card')[i];
  assert.ok(card(0).querySelector('.cardScalable > .je-arr-badge .je-arr-ring'));
  assert.equal(card(0).querySelector('.je-arr-ring-text').textContent, '42');
  assert.equal(card(1).querySelector('.je-arr-badge'), null, 'quiet');
  assert.equal(card(2).querySelector('.je-arr-badge .material-icons').textContent, 'hourglass_bottom');
  assert.equal(card(3).querySelector('.je-arr-badge .material-icons').textContent, 'schedule');
  assert.equal(card(130).querySelector('.je-arr-badge'), null, 'never asked for (off screen)');

  // A change for one title re-fetches only its cards.
  answers.set('00000000000000000000000000000000', { ...answers.get('00000000000000000000000000000000'), stage: 'almostReady', reason: { code: 'importing' }, progress: null });
  h.S.refresh(['movie:tmdb:1']);
  await h.JE.internals.arrStatusCards.flush();
  assert.equal(h.calls.length, 3);
  same(decodeURIComponent(/ids=([^&]*)/.exec(h.calls[2].path)[1]).split(','), ['00000000000000000000000000000000']);
  assert.equal(card(0).querySelector('.je-arr-badge .material-icons').textContent, 'hourglass_bottom');
});

test('season cards show ✓ when complete and "◐ ready/aired" when not, plus the download ring', t => {
  const h = setup(t);
  const done = h.S.buildBadge({ key: 's1', kind: 'season', stage: 'ready', quiet: true, summary: { aired: 6, ready: 6, missing: 0 } });
  assert.equal(done.querySelector('.material-icons').textContent, 'check');
  const partial = h.S.buildBadge({ key: 's3', kind: 'season', stage: 'downloading', summary: { aired: 10, ready: 4, missing: 4, downloading: 1 }, progress: { percent: 60 } });
  assert.equal(partial.querySelector('.je-arr-badge-chip').textContent, '◐ 4/10');
  assert.ok(partial.querySelector('.je-arr-ring'));
  assert.equal(partial.getAttribute('aria-label'), '4 of 10 ready, Downloading 60%');
  assert.equal(h.S.buildBadge({ key: 'm', kind: 'movie', stage: 'ready', quiet: true }), null);
  const busy = h.S.buildBadge({ key: 'x', kind: 'series', stage: 'downloading', summary: { downloading: 2 } });
  assert.ok(busy.querySelector('.je-arr-ring-busy'), 'several downloads: an indeterminate ring');
});

test('with the status flags off nothing starts and nothing is requested', async t => {
  const h = setup(t, { html: cardsHtml(5) + detailsHtml, hash: '#/details?id=x', config: { ArrStatusEnabled: false } });
  h.JE.initializeArrStatus();
  await h.JE.internals.arrStatusDetails.update(true);
  assert.equal(h.observers.length, 0);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.document.getElementById('je-arr-status-styles'), null);

  const noBadges = setup(t, { html: cardsHtml(5), config: { ArrStatusPosterBadges: false } });
  noBadges.JE.initializeArrStatus();
  assert.equal(noBadges.observers.length, 0, 'poster badges switched off: no observer');
  assert.ok(noBadges.document.getElementById('je-arr-status-styles'));
});

test('subscribe hands keys to the change feed when there is one and unsubscribes cleanly', t => {
  const h = setup(t);
  const seen = [];
  let external = 0;
  h.JE.arr = { onStatusChange: (keys, cb) => { seen.push(keys); cb(['tv:tvdb:1:s1:e2']); return () => { external++; }; } };
  const got = [];
  const off = h.S.subscribe(['tv:tvdb:1:s1', 'tv:tvdb:1:s1'], keys => got.push(keys));
  same(seen, [['tv:tvdb:1:s1', 'tv:tvdb:1']], 'a season surface also follows its series (new episodes are announced under it first)');
  same(got, [['tv:tvdb:1:s1:e2']]);
  assert.equal(h.S.refresh(['tv:tvdb:1']), 1, 'a series change refreshes its season surfaces');
  off();
  assert.equal(external, 1);
  assert.equal(h.S.refresh(['tv:tvdb:1:s1']), 0);
});

test('poster badges forget titles whose cards are gone: no re-fetch, no subscription for them', async t => {
  const answers = id => ({ itemId: id, key: `movie:tmdb:${parseInt(id, 16) + 1}`, kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 10 } });
  const h = setup(t, {
    html: cardsHtml(3),
    responses: path => ({ items: decodeURIComponent(/ids=([^&]*)/.exec(path)[1]).split(',').map(answers) })
  });
  const followed = [];
  h.JE.arr = { onStatusChange: keys => { followed.push([...keys]); return () => {}; } };
  h.JE.initializeArrStatus();
  h.JE.internals.arrStatusCards.scan();
  const io = h.observers[0];
  io.fn([...io.observed].map(target => ({ isIntersecting: true, target })));
  await h.JE.internals.arrStatusCards.flush();
  same(followed.at(-1), ['movie:tmdb:1', 'movie:tmdb:2', 'movie:tmdb:3']);

  // The user navigates on: the first two cards are gone.
  const cards = h.document.querySelectorAll('.card[data-type="Movie"]');
  cards[0].remove();
  cards[1].remove();
  const before = h.calls.length;
  h.S.refresh(['movie:tmdb:1', 'movie:tmdb:2', 'movie:tmdb:3']);
  await h.JE.internals.arrStatusCards.flush();
  assert.equal(h.calls.length, before + 1);
  same(decodeURIComponent(/ids=([^&]*)/.exec(h.calls.at(-1).path)[1]).split(','), ['00000000000000000000000000000002']);
  same([...h.JE.internals.arrStatusCards.idsByKey.keys()], ['movie:tmdb:3']);
  same(followed.at(-1), ['movie:tmdb:3']);
  // Nothing shown any more: no request at all.
  cards[2].remove();
  h.S.refresh(['movie:tmdb:3']);
  await h.JE.internals.arrStatusCards.flush();
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.JE.internals.arrStatusCards.idsByKey.size, 0);
});

test('a details page with no status (person, collection, album) is asked for once per view', async t => {
  const h = setup(t, { html: detailsHtml, hash: '#/details?id=person1', responses: () => ({ items: [] }) });
  await h.JE.internals.arrStatusDetails.update(false);
  await h.JE.internals.arrStatusDetails.update(false);
  await h.JE.internals.arrStatusDetails.update(false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.document.querySelector('.je-arr-status'), null);
  // A failed request is not retried on every view event either.
  const failing = setup(t, { html: detailsHtml, hash: '#/details?id=movie9', responses: () => Object.assign(new Error('HTTP 500'), { status: 500 }) });
  await failing.JE.internals.arrStatusDetails.update(false);
  await failing.JE.internals.arrStatusDetails.update(false);
  assert.equal(failing.calls.length, 1);
});

test('poster badges take a corner no JE poster tag uses', async t => {
  const h = setup(t, { html: cardsHtml(1) });
  const status = { itemId: '00000000000000000000000000000000', key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 10 } };
  const card = h.document.querySelector('.card');
  const corner = () => {
    h.JE.internals.arrStatusCards.paint(card, status);
    return [...card.querySelector('.je-arr-badge').classList].filter(c => c !== 'je-arr-badge').join(' ');
  };
  assert.equal(corner(), 'je-arr-badge-bottom-left', 'no tags: bottom-left');
  // Language tags on (default bottom-left): the badge moves out of their way.
  h.JE.currentSettings = { languageTagsEnabled: true };
  assert.equal(corner(), 'je-arr-badge-bottom-right');
  // Rating tags bottom-right too, quality top-left (admin default moved by the user's own setting).
  h.JE.currentSettings = { languageTagsEnabled: true, ratingTagsEnabled: true, qualityTagsEnabled: true, qualityTagsPosition: 'top-left' };
  assert.equal(corner(), 'je-arr-badge-top-right');
  h.JE.pluginConfig.LanguageTagsPosition = 'top-right';
  assert.equal(corner(), 'je-arr-badge-bottom-left', 'the admin default position is honoured');
  h.JE.currentSettings = { languageTagsEnabled: true, ratingTagsEnabled: true, qualityTagsEnabled: true, genreTagsEnabled: true, languageTagsPosition: 'bottom-left' };
  assert.equal(corner(), 'je-arr-badge-bottom-left je-arr-badge-raised', 'every corner taken: raised above the tags');
  assert.equal(card.querySelectorAll('.je-arr-badge').length, 1);
  const css = h.document.getElementById('je-arr-status-styles')?.textContent || h.JE.internals.arrStatusStyles.CSS;
  for (const c of ['bottom-right', 'top-left', 'top-right', 'raised']) assert.match(css, new RegExp(`\\.je-arr-badge-${c} `));
});

test('poster badges keep answers only for cards on the page; a card that comes back is asked for again and followed', async t => {
  let stage = 'downloading';
  const answer = id => ({ itemId: id, key: `movie:tmdb:${parseInt(id, 16) + 1}`, kind: 'movie', stage, reason: { code: stage === 'downloading' ? 'downloading' : 'importing' }, progress: stage === 'downloading' ? { percent: 40 } : null });
  const h = setup(t, {
    html: cardsHtml(2),
    responses: path => ({ items: decodeURIComponent(/ids=([^&]*)/.exec(path)[1]).split(',').map(answer) })
  });
  const followed = [];
  h.JE.arr = { onStatusChange: keys => { followed.push([...keys]); return () => {}; } };
  h.JE.initializeArrStatus();
  const cards = h.JE.internals.arrStatusCards;
  cards.scan();
  const io = h.observers[0];
  io.fn([...io.observed].map(target => ({ isIntersecting: true, target })));
  await cards.flush();
  assert.equal(cards.cache.size, 2);

  // Card 0 leaves the page (navigation): its answer goes with it, the cache stays the page's size.
  const first = h.document.querySelector('.card[data-type="Movie"]');
  const parent = first.parentNode;
  first.remove();
  cards.prune();
  same([...cards.cache.keys()], ['00000000000000000000000000000001']);

  // Its title finishes while it is gone; it comes back (a re-rendered card) within the minute: it is
  // asked for again (not painted from an old answer) and followed again.
  stage = 'almostReady';
  h.S.refresh(['movie:tmdb:1']);
  const back = first.cloneNode(true);
  back.querySelectorAll('.je-arr-badge').forEach(n => n.remove());
  parent.insertBefore(back, parent.firstChild);
  const before = h.calls.length;
  io.fn([{ isIntersecting: true, target: back }]);
  await cards.flush();
  assert.equal(h.calls.length, before + 1);
  assert.equal(back.querySelector('.je-arr-badge .material-icons').textContent, 'hourglass_bottom');
  assert.ok(followed.at(-1).includes('movie:tmdb:1'));
  assert.equal(h.S.refresh(['movie:tmdb:1']) > 0, true, 'a change of the returned card reaches it');
  await cards.flush();

  // A card painted from the cache follows its title again even if a prune dropped it meanwhile.
  cards.idsByKey.delete('movie:tmdb:2');
  const second = h.document.querySelectorAll('.card[data-type="Movie"]')[1];
  io.fn([{ isIntersecting: true, target: second }]);
  await new Promise(r => setTimeout(r, 5));
  assert.ok(cards.idsByKey.get('movie:tmdb:2')?.has('00000000000000000000000000000001'));
  assert.ok(followed.at(-1).includes('movie:tmdb:2'));

  // Expired answers are dropped even for cards still shown.
  cards.cache.get('00000000000000000000000000000001').at = Date.now() - 61000;
  cards.prune();
  assert.equal(cards.cache.has('00000000000000000000000000000001'), false);
});

test('the details surface sends nothing in the first 400 ms, even for an early navigation or view event', async t => {
  const h = setup(t, {
    html: detailsHtml, hash: '#/details?id=movie1',
    responses: () => ({ items: [{ key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 42 } }] })
  });
  h.JE.initializeArrStatus();
  const started = Date.now();
  for (const fn of h.navigation) fn();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(h.calls.length, 0, 'no request during load');
  for (const fn of h.navigation) fn();
  await new Promise(r => setTimeout(r, 450 - (Date.now() - started)));
  await nextTurn();
  assert.equal(h.calls.length, 1, 'one look once the page has settled');
  assert.match(h.document.querySelector('.detailSection').textContent, /Downloading · 42%/);
});
