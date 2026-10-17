// Requests & downloads: a details page whose title arrives turns into the playable page by itself. One
// arrival rule for every details page (episode, season, series, movie and the native page of a title not
// in the library), fed by the page's status reads, JE's change feed and Jellyfin's LibraryChanged message:
// the same item becoming available gets one reload of Jellyfin's own page; an item Jellyfin replaced
// (a missing episode or season gets a new id once its file is there) is swapped for its successor in the
// history entry. Never while the viewer types, plays or has a dialog open, never twice for one change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = ['arr/status/status-core.js', 'arr/status/status-episodes.js', 'arr/status/status-arrival.js', 'arr/status/status-details.js'];
const SERVER = '0202511b0eac4284ab045b3ba556d72e';
const OLD = '9dbfb432fc735d2d804ec29ba1bc8d7b';
const NEW = '11864b571daf8f01b9b76a0a24db20e8';
const SEASON = 'e699ee5ee84ca95d39a9d80fbde44392';
const SERIES = '9a6d71cc6ad01dba7ebb73a2b3593501';
const KEY = 'tv:tvdb:75932:s1:e3';

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

const page = (type = 'Episode') => `<div id="itemDetailPage" class="page libraryPage" data-type="${type}">`
  + '<div class="detailPagePrimaryContainer"><div class="detailPagePrimaryContent"><div class="detailSection"></div></div>'
  + '<div class="mainDetailButtons"><button class="btnPlay hide" type="button"></button><button class="btnMoreCommands" type="button"></button></div></div></div>';

/**
 * The real status modules on a details page, with the arrival rule at fast timings. `answers(path, n)`
 * answers each plugin call (status reads and the arrival route); `items` are what Jellyfin returns per id.
 */
function setup(t, { hash = `#/details?id=${OLD}&serverId=${SERVER}&context=tvshows`, type, answers = () => null, items = {}, apiClient = {}, config = {}, html } = {}) {
  const calls = [];
  const replays = [];
  const itemReads = [];
  const userChange = [];
  const h = createHarness({
    html: html ?? page(type),
    url: `http://jellyfin.test/web/index.html${hash}`,
    apiClient,
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ...config },
      t: translate,
      helpers: {
        debounce: fn => fn,
        addCSS: () => {},
        onBodyMutation: () => ({ unsubscribe() {} }),
        getItemCached: (id, options) => { itemReads.push({ id, options: options || {} }); return Promise.resolve(items[id] || null); }
      },
      core: {
        api: {
          plugin: async (path, options) => {
            calls.push({ path, options });
            const answer = answers(path, calls.filter(c => c.path.startsWith(path.split('?')[0])).length);
            if (answer instanceof Error) throw answer;
            return answer;
          }
        },
        navigation: { onNavigate: () => () => {}, onViewPage: () => () => {}, replayViewShow: el => replays.push(el) },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: (k, fn) => userChange.push(fn) }
    }
  });
  t.after(() => h.close());
  for (const m of MODULES) h.load(m);
  const A = h.JE.internals.arrStatusArrival;
  Object.assign(A.timing, { probe: 5, recheck: 5, settle: 5, gap: 0, batch: 0 });
  const view = h.document.querySelector('#itemDetailPage');
  const host = { shows: [], hides: [], bubbled: 0 };
  view.addEventListener('viewbeforehide', e => host.hides.push(e));
  view.addEventListener('viewshow', e => host.shows.push(e));
  h.document.addEventListener('viewshow', () => { host.bubbled++; });
  return {
    ...h, calls, replays, itemReads, userChange, A, view, host,
    S: h.JE.arrStatus,
    D: h.JE.internals.arrStatusDetails,
    statusReads: () => calls.filter(c => c.path.startsWith('/acquire/status/item/')).length,
    arrivalReads: () => calls.filter(c => c.path.startsWith('/acquire/status/arrival')),
    id: () => new URLSearchParams(h.window.location.hash.split('?')[1] || '').get('id')
  };
}

const until = async (fn, ms = 1000) => {
  for (let waited = 0; waited < ms; waited += 5) {
    if (fn()) return true;
    await sleep(5);
  }
  return !!fn();
};

const episode = (stage, extra = {}) => ({ items: [{ key: KEY, itemId: OLD, kind: 'episode', stage, reason: { code: stage === 'ready' ? 'ready' : 'downloading' }, ...extra }] });
const season = (ready, extra = {}) => ({ items: [{ key: 'tv:tvdb:75932:s1', itemId: SEASON, kind: 'season', stage: 'downloading', reason: { code: 'partial' }, summary: { aired: 6, ready, missing: 6 - ready }, episodes: [], ...extra }] });

test('a missing episode Jellyfin replaced with its file is swapped for the new item in the same history entry', async t => {
  const h = setup(t, { answers: (path, n) => (n === 1 ? episode('almostReady') : episode('ready', { itemId: NEW, openItemId: NEW })) });
  await h.D.update(false);
  const length = h.window.history.length;
  assert.equal(h.S.refresh([KEY]), 1);
  assert.ok(await until(() => h.id() === NEW), 'the page moves to the episode that has the file');
  assert.equal(h.window.location.hash, `#/details?id=${NEW}&serverId=${SERVER}&context=tvshows`, 'server and context kept');
  assert.equal(h.window.history.length, length, 'no new history entry: Back goes where it went before');
  assert.equal(h.host.shows.length, 0, 'no reload of the old item');
});

test('a missing episode Jellyfin deleted is followed to its successor by key, and its panel stays meanwhile', async t => {
  const h = setup(t, {
    answers: (path, n) => {
      if (path.startsWith('/acquire/status/arrival')) return { itemId: NEW };
      return n === 1 ? episode('almostReady') : { items: [] };
    }
  });
  await h.D.update(false);
  assert.ok(h.document.querySelector('.je-arr-status[data-je-arr-surface="details"]'));
  h.S.refresh([KEY]);
  assert.ok(await until(() => h.id() === NEW));
  const [arrival] = h.arrivalReads();
  assert.equal(arrival.path, `/acquire/status/arrival?key=${encodeURIComponent(KEY)}&itemId=${OLD}`);
  assert.ok(h.document.querySelector('.je-arr-status[data-je-arr-surface="details"]'), 'the old page keeps its panel until it is replaced');
});

test('Jellyfin adds the file\'s episode a moment after it deletes the missing one: the page keeps its panel and looks again', async t => {
  let arrived = false;
  const h = setup(t, {
    answers: (path, n) => {
      if (path.startsWith('/acquire/status/arrival')) return { itemId: arrived ? NEW : null };
      return n === 1 ? episode('almostReady') : { items: [] };
    }
  });
  h.A.timing.lost = [20, 20, 20, 20];
  await h.D.update(false);
  h.S.refresh([KEY]);
  assert.ok(await until(() => h.arrivalReads().length === 1));
  await sleep(5);
  assert.ok(h.document.querySelector('.je-arr-status[data-je-arr-surface="details"]'), 'the panel stays while it looks again');
  arrived = true;
  assert.ok(await until(() => h.id() === NEW), 'the next look finds it');
});

test('a deleted item with no successor the viewer can open drops its panel as before', async t => {
  let manage = 0;
  const h = setup(t, {
    answers: (path, n) => {
      if (path.startsWith('/acquire/status/arrival')) return { itemId: null };
      return n === 1 ? episode('almostReady') : { items: [] };
    }
  });
  h.JE.internals.arrManage = { attachDetails: (p, s) => { if (s === null) manage++; } };
  h.A.timing.lost = [5, 5];
  await h.D.update(false);
  h.S.refresh([KEY]);
  assert.ok(await until(() => !h.document.querySelector('.je-arr-status')));
  assert.equal(manage, 1);
  assert.equal(h.id(), OLD);
  assert.equal(h.arrivalReads().length, 3, 'asked once, then once per pause, then it gives up');
  await sleep(40);
  assert.equal(h.arrivalReads().length, 3, 'and stops asking');
  assert.equal(h.statusReads(), 4, 'the page read, the change, one read per pause: nothing more');
});

test('the same item becoming available reloads Jellyfin\'s own page once, keeping scroll, and JE redraws on it', async t => {
  const h = setup(t, { answers: (path, n) => (n === 1 ? episode('downloading') : episode('ready')) });
  await h.D.update(false);
  const scroller = h.document.documentElement;
  scroller.scrollTop = 400;
  // The host redraws its page from the top.
  h.view.addEventListener('viewshow', () => { scroller.scrollTop = 0; });
  h.S.refresh([KEY]);
  assert.ok(await until(() => h.host.shows.length === 1));
  assert.equal(h.host.hides.length, 1, 'the host releases what its last show subscribed first');
  assert.equal(h.host.shows[0].detail.isRestored, false, 'a fresh show: Jellyfin reads its item again');
  assert.equal(h.host.shows[0].bubbles, false, 'only the page hears it (no theme music, no router)');
  assert.equal(h.host.bubbled, 0);
  assert.ok(h.itemReads.some(r => r.id === OLD && r.options.forceRefresh), 'JE\'s item cache is refreshed for the page');
  assert.ok(await until(() => h.replays.includes(h.view)), 'JE\'s page handlers run again on the redrawn page');
  assert.equal(scroller.scrollTop, 400, 'the viewer stays where they were');
  // The reload's own reads and repeated change events are the same arrival: nothing more.
  const reads = h.statusReads();
  h.S.refresh([KEY]);
  h.S.refresh([KEY]);
  await until(() => h.statusReads() >= reads + 2);
  await sleep(40);
  assert.equal(h.host.shows.length, 1);
});

test('a season gaining episodes reloads once per change; downloads moving along never do', async t => {
  let ready = 1;
  let stage = 'downloading';
  const h = setup(t, { type: 'Season', hash: `#/details?id=${SEASON}&serverId=${SERVER}`, answers: () => season(ready, { stage }) });
  await h.D.update(false);
  stage = 'almostReady';
  h.S.refresh(['tv:tvdb:75932:s1']);
  await sleep(40);
  assert.equal(h.host.shows.length, 0, 'almost ready is not here yet');
  ready = 2;
  h.S.refresh(['tv:tvdb:75932:s1']);
  assert.ok(await until(() => h.host.shows.length === 1));
  h.S.refresh(['tv:tvdb:75932:s1']);
  await sleep(40);
  assert.equal(h.host.shows.length, 1, 'the same count again is no new arrival');
  ready = 3;
  h.S.refresh(['tv:tvdb:75932:s1']);
  assert.ok(await until(() => h.host.shows.length === 2));
});

test('a season page waits for a burst of arrivals (and Jellyfin tidying up after them) to settle, then reloads once', async t => {
  let ready = 1;
  const h = setup(t, { type: 'Season', hash: `#/details?id=${SEASON}&serverId=${SERVER}`, answers: () => season(ready) });
  h.A.timing.batch = 200;
  await h.D.update(false);
  ready = 2;
  h.S.refresh(['tv:tvdb:75932:s1']);
  await sleep(50);
  ready = 3;
  h.S.refresh(['tv:tvdb:75932:s1']);
  await sleep(150);
  // Jellyfin dropped the missing episode the file replaced: the same count, read again.
  h.S.refresh(['tv:tvdb:75932:s1']);
  await sleep(120);
  assert.equal(h.host.shows.length, 0, 'not while it keeps changing');
  assert.ok(await until(() => h.host.shows.length === 1, 1000));
  await sleep(200);
  assert.equal(h.host.shows.length, 1, 'one reload for the burst');
});

test('reloads of one page are spaced out: a burst of arrivals gets one more reload after the gap', async t => {
  let ready = 1;
  const h = setup(t, { type: 'Season', hash: `#/details?id=${SEASON}&serverId=${SERVER}`, answers: () => season(ready) });
  h.A.timing.gap = 150;
  await h.D.update(false);
  ready = 2;
  h.S.refresh(['tv:tvdb:75932:s1']);
  assert.ok(await until(() => h.host.shows.length === 1));
  ready = 3;
  h.S.refresh(['tv:tvdb:75932:s1']);
  ready = 4;
  await sleep(10);
  h.S.refresh(['tv:tvdb:75932:s1']);
  await sleep(60);
  assert.equal(h.host.shows.length, 1, 'not again within the gap');
  assert.ok(await until(() => h.host.shows.length === 2, 1500));
  await sleep(200);
  assert.equal(h.host.shows.length, 2, 'the burst is one more reload');
});

test('an open dialog, typing or playback holds the change until it ends; it is checked again right before', async t => {
  for (const kind of ['dialog', 'sheet', 'typing', 'playing']) {
    await t.test(kind, async st => {
      const h = setup(st, { answers: (path, n) => (n === 1 ? episode('almostReady') : episode('ready', { itemId: NEW, openItemId: NEW })) });
      await h.D.update(false);
      let end;
      if (kind === 'dialog') {
        const box = h.document.createElement('div');
        box.className = 'dialogContainer';
        box.innerHTML = '<div class="dialog opened"></div>';
        h.document.body.appendChild(box);
        end = () => box.remove();
      } else if (kind === 'sheet') {
        const sheet = h.document.createElement('div');
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        h.document.body.appendChild(sheet);
        end = () => sheet.remove();
      } else if (kind === 'typing') {
        const input = h.document.createElement('input');
        input.type = 'text';
        h.document.body.appendChild(input);
        input.focus();
        end = () => input.blur();
      } else {
        const bar = h.document.createElement('div');
        bar.className = 'nowPlayingBar';
        h.document.body.appendChild(bar);
        end = () => bar.classList.add('hide', 'nowPlayingBar-hidden');
      }
      assert.equal(h.A.busy(), kind === 'sheet' ? 'dialog' : kind);
      h.S.refresh([KEY]);
      await sleep(60);
      assert.equal(h.id(), OLD, `held while ${kind}`);
      end();
      assert.ok(await until(() => h.id() === NEW), `goes once the ${kind} ends`);
    });
  }
});

test('leaving the page or switching user while a change waits cancels it', async t => {
  const h = setup(t, { answers: (path, n) => (n === 1 ? episode('almostReady') : episode('ready', { itemId: NEW, openItemId: NEW })) });
  await h.D.update(false);
  const box = h.document.createElement('div');
  box.className = 'dialogContainer';
  box.innerHTML = '<div class="dialog opened"></div>';
  h.document.body.appendChild(box);
  h.S.refresh([KEY]);
  await sleep(30);
  h.window.location.hash = `#/details?id=${SERIES}&serverId=${SERVER}`;
  await sleep(10);
  box.remove();
  await sleep(60);
  assert.equal(h.id(), SERIES, 'never sent back to the old page\'s successor');
  assert.equal(h.A.state(), null, 'the old page is forgotten, nothing keeps checking');

  const u = setup(t, { answers: (path, n) => (n === 1 ? episode('almostReady') : episode('ready', { itemId: NEW, openItemId: NEW })) });
  await u.D.update(false);
  const input = u.document.createElement('input');
  u.document.body.appendChild(input);
  input.focus();
  u.S.refresh([KEY]);
  await sleep(30);
  u.userChange.forEach(fn => fn());
  input.blur();
  await sleep(60);
  assert.equal(u.id(), OLD);
});

test('a page reached after its item was replaced (Back to the missing episode) moves on at its first read', async t => {
  const h = setup(t, { answers: () => episode('ready', { itemId: NEW, openItemId: NEW }) });
  await h.D.update(false);
  assert.ok(await until(() => h.id() === NEW));
});

test('back on a page whose item Jellyfin deleted meanwhile (the viewer was on other pages), it still finds its successor', async t => {
  let deleted = false;
  const h = setup(t, {
    answers: (path) => {
      if (path.startsWith('/acquire/status/arrival')) return { itemId: NEW };
      if (path.includes(SERIES)) return { items: [{ key: 'tv:tvdb:75932', itemId: SERIES, kind: 'series', stage: 'ready', reason: { code: 'ready' }, summary: { aired: 12, ready: 4 } }] };
      return deleted ? { items: [] } : episode('almostReady');
    }
  });
  await h.D.update(false);
  // Off to the series page, then the player: the details surface follows them and lets the episode go.
  h.window.location.hash = `#/details?id=${SERIES}&serverId=${SERVER}`;
  await h.D.update(false);
  h.window.location.hash = '#/video';
  await h.D.update(false);
  deleted = true;
  h.window.location.hash = `#/details?id=${OLD}&serverId=${SERVER}&context=tvshows`;
  await h.D.update(false);
  assert.ok(await until(() => h.id() === NEW), 'the page that came back moves on by the key it had');
});

test('a page Jellyfin restored with its missing badge although the item has its file now is reloaded at its first read', async t => {
  const h = setup(t, { answers: () => episode('ready') });
  const badge = h.document.createElement('div');
  badge.className = 'missingIndicator';
  h.document.querySelector('.detailPagePrimaryContainer').appendChild(badge);
  await h.D.update(false);
  assert.ok(await until(() => h.host.shows.length === 1));
});

test('a page that is already playable, unrelated titles and other statuses never move or reload', async t => {
  const h = setup(t, { answers: () => episode('ready') });
  await h.D.update(false);
  h.S.refresh([KEY]);
  h.S.refresh(['movie:tmdb:1']);
  await sleep(60);
  assert.equal(h.host.shows.length, 0);
  assert.equal(h.id(), OLD);
  assert.equal(h.arrivalReads().length, 0);
});

test('a target that is not a library item id (a page id, junk) is never opened', async t => {
  const h = setup(t, { answers: (path, n) => (n === 1 ? episode('almostReady') : episode('ready', { openItemId: '4a45ad120001479b00000000c8f267bc' })) });
  h.JE.titleDetails = { isSynthetic: id => String(id || '').startsWith('4a45ad1') };
  await h.D.update(false);
  h.S.refresh([KEY]);
  await sleep(60);
  assert.equal(h.id(), OLD);
});

test('the native page of a title not in the library becomes the library title once a copy arrives', async t => {
  const PAGE = '4a45ad120001479b00000000c8f267bc';
  const COPY = 'aaaabbbbccccddddeeeeffff00001111';
  const h = setup(t, {
    type: 'Movie', hash: `#/details?id=${PAGE}&serverId=${SERVER}`,
    answers: (path, n) => ({ items: [{ key: 'movie:tmdb:603', itemId: PAGE, kind: 'movie', stage: n === 1 ? 'downloading' : 'ready', reason: { code: n === 1 ? 'downloading' : 'ready' }, ...(n === 1 ? {} : { openItemId: COPY }) }] })
  });
  h.JE.titleDetails = { isSynthetic: id => String(id || '').startsWith('4a45ad1'), parse: id => (String(id).startsWith('4a45ad1') ? { kind: 'movie', tmdbId: 603 } : null) };
  await h.D.update(false);
  h.S.refresh(['movie:tmdb:603']);
  assert.ok(await until(() => h.id() === COPY));
  // The native page's own first-look redirect goes through the same rule (held while a dialog is open).
  const n = setup(t, { type: 'Movie', hash: `#/details?id=${PAGE}&serverId=${SERVER}` });
  const box = n.document.createElement('div');
  box.className = 'dialogContainer';
  box.innerHTML = '<div class="dialog opened"></div>';
  n.document.body.appendChild(box);
  n.A.open(n.view, PAGE, COPY);
  await sleep(40);
  assert.equal(n.id(), PAGE);
  box.remove();
  assert.ok(await until(() => n.id() === COPY));
});

test('Jellyfin\'s LibraryChanged message for the page\'s item or its parents asks again (12.x subscribe)', async t => {
  const handlers = [];
  let unsubscribed = 0;
  const apiClient = {
    subscribe: (types, fn) => { handlers.push({ types, fn }); return () => { unsubscribed++; }; }
  };
  const h = setup(t, {
    apiClient,
    items: { [OLD]: { Id: OLD, Type: 'Episode', SeriesId: SERIES, SeasonId: SEASON, ParentId: SEASON, LocationType: 'Virtual' } },
    answers: (path, n) => (n === 1 ? episode('almostReady') : episode('ready', { itemId: NEW, openItemId: NEW }))
  });
  await h.D.update(false);
  assert.ok(await until(() => handlers.length === 1));
  assert.deepEqual([...handlers[0].types], ['LibraryChanged']);
  const reads = h.statusReads();
  handlers[0].fn({ MessageType: 'LibraryChanged', Data: { ItemsAdded: ['ffffffffffffffffffffffffffffffff'], ItemsUpdated: [], ItemsRemoved: [] } });
  await sleep(40);
  assert.equal(h.statusReads(), reads, 'another title\'s change asks nothing');
  // The file's episode lands in the page's season (the missing episode itself stays listed for now).
  const folder = { MessageType: 'LibraryChanged', Data: { ItemsAdded: [NEW], FoldersAddedTo: [SEASON.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')], ItemsRemoved: [] } };
  handlers[0].fn(folder);
  handlers[0].fn(folder);
  assert.ok(await until(() => h.id() === NEW));
  assert.equal(h.statusReads(), reads + 1, 'two messages close together are one read');
  h.userChange.forEach(fn => fn());
  assert.equal(unsubscribed, 1, 'a user switch ends the subscription');
});

test('a season or series page reloads when Jellyfin removes something it lists (the missing episode a file replaced)', async t => {
  const handlers = [];
  const h = setup(t, {
    type: 'Season', hash: `#/details?id=${SEASON}&serverId=${SERVER}`,
    apiClient: { subscribe: (types, fn) => { handlers.push(fn); return () => {}; } },
    items: { [SEASON]: { Id: SEASON, Type: 'Season', SeriesId: SERIES } },
    answers: () => season(5)
  });
  await h.D.update(false);
  assert.ok(await until(() => handlers.length === 1));
  // Another series' episode removed: nothing.
  handlers[0]({ MessageType: 'LibraryChanged', Data: { ItemsRemoved: ['ffffffffffffffffffffffffffffffff'], FoldersRemovedFrom: ['eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'] } });
  await sleep(40);
  assert.equal(h.host.shows.length, 0);
  // Its missing E6 removed (the file's E6 is already counted): Jellyfin's list redraws once.
  handlers[0]({ MessageType: 'LibraryChanged', Data: { ItemsRemoved: [OLD], FoldersRemovedFrom: [SEASON] } });
  assert.ok(await until(() => h.host.shows.length === 1));
  await sleep(40);
  assert.equal(h.host.shows.length, 1);
});

test('Jellyfin deleting the page\'s own item asks again too', async t => {
  const handlers = [];
  const h = setup(t, {
    apiClient: { subscribe: (types, fn) => { handlers.push(fn); return () => {}; } },
    answers: (path, n) => {
      if (path.startsWith('/acquire/status/arrival')) return { itemId: NEW };
      return n === 1 ? episode('almostReady') : { items: [] };
    }
  });
  await h.D.update(false);
  assert.ok(await until(() => handlers.length === 1));
  handlers[0]({ MessageType: 'LibraryChanged', Data: { ItemsRemoved: [OLD] } });
  assert.ok(await until(() => h.id() === NEW));
});

test('10.11: the same message through the API client\'s message event', async t => {
  const apiClient = { _callbacks: {} };
  const h = setup(t, {
    apiClient,
    items: { [OLD]: { Id: OLD, Type: 'Episode', SeriesId: SERIES, SeasonId: SEASON } },
    answers: (path, n) => (n === 1 ? episode('almostReady') : episode('ready', { itemId: NEW, openItemId: NEW }))
  });
  await h.D.update(false);
  const list = () => h.window.ApiClient._callbacks.message || [];
  assert.ok(await until(() => list().length === 1));
  list().forEach(fn => fn.call(h.window.ApiClient, { type: 'message' }, { MessageType: 'UserDataChanged', Data: { UserDataList: [{ ItemId: OLD }] } }));
  await sleep(30);
  assert.equal(h.id(), OLD, 'user data is no arrival');
  list().forEach(fn => fn.call(h.window.ApiClient, { type: 'message' }, { MessageType: 'LibraryChanged', Data: { ItemsRemoved: [OLD] } }));
  assert.ok(await until(() => h.id() === NEW));
  h.userChange.forEach(fn => fn());
  assert.equal(list().length, 0);
});

test('with the status surfaces off nothing listens and nothing moves', async t => {
  const handlers = [];
  const h = setup(t, {
    config: { ArrStatusEnabled: false },
    apiClient: { subscribe: (types, fn) => { handlers.push(fn); return () => {}; } },
    answers: () => episode('ready', { itemId: NEW, openItemId: NEW })
  });
  h.JE.pluginConfig.ArrIntegrationEnabled = false;
  h.JE.pluginConfig.ArrPhase1Enabled = false;
  await h.D.update(false);
  await sleep(40);
  assert.equal(h.calls.length, 0);
  assert.equal(handlers.length, 0);
  assert.equal(h.id(), OLD);
});
