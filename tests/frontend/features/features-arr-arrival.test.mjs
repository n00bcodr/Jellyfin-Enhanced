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
  const session = { epoch: 0 };
  const navigations = [];
  const views = [];
  const h = createHarness({
    html: html ?? page(type),
    url: `http://jellyfin.test/web/index.html${hash}`,
    // Jellyfin answers the viewer's item reads (the destination check before a move) unless a test says otherwise.
    apiClient: { getItem: async (user, id) => ({ Id: id }), ...apiClient },
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
            const answer = answers(path, calls.filter(c => c.path.startsWith(path.split('?')[0])).length, options);
            if (answer instanceof Error) throw answer;
            return answer;
          }
        },
        navigation: { onNavigate: fn => { navigations.push(fn); return () => {}; }, onViewPage: fn => { views.push(fn); return () => {}; }, replayViewShow: el => replays.push(el) },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      session: { getEpoch: () => session.epoch, isCurrent: e => e === session.epoch, onUserChange: (k, fn) => userChange.push(fn) }
    }
  });
  t.after(() => {
    h.JE.internals?.arrStatusDetails?.stop();
    h.close();
  });
  for (const m of MODULES) h.load(m);
  const A = h.JE.internals.arrStatusArrival;
  Object.assign(A.timing, { probe: 5, recheck: 5, settle: 5, gap: 0, batch: 0 });
  const view = h.document.querySelector('#itemDetailPage');
  const host = { shows: [], hides: [], bubbled: 0 };
  view.addEventListener('viewbeforehide', e => host.hides.push(e));
  view.addEventListener('viewshow', e => host.shows.push(e));
  h.document.addEventListener('viewshow', () => { host.bubbled++; });
  return {
    ...h, calls, replays, itemReads, userChange, session, navigations, views, A, view, host,
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

/** Jellyfin's open dialog over the page; returns a function that closes it. */
function openDialog(h) {
  const box = h.document.createElement('div');
  box.className = 'dialogContainer';
  box.innerHTML = '<div class="dialog opened"></div>';
  h.document.body.appendChild(box);
  return () => box.remove();
}

const episode = (stage, extra = {}) => ({ items: [{ key: KEY, itemId: OLD, kind: 'episode', stage, reason: { code: stage === 'ready' ? 'ready' : 'downloading' }, ...extra }] });
const series = (ready, extra = {}) => ({ items: [{ key: 'tv:tvdb:75932', itemId: SERIES, kind: 'series', stage: 'downloading', reason: { code: 'partial' }, summary: { aired: 12, ready, missing: 12 - ready }, ...extra }] });
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
  assert.ok(await until(() => scroller.scrollTop === 400), 'the accepted status is repainted after host settlement');
  assert.equal(h.replays.length, 1, 'one replay after cached status reconciliation');
  assert.equal(scroller.scrollTop, 400, 'the viewer stays where they were');
  // The reload's own reads and repeated change events are the same arrival: nothing more.
  const reads = h.statusReads();
  h.S.refresh([KEY]);
  h.S.refresh([KEY]);
  await sleep(40);
  assert.equal(h.statusReads(), reads + 2, 'only the two explicit status notifications read again');
  assert.equal(h.host.shows.length, 1);
});

const MOVIE_KEY = 'movie:tmdb:45745';
const movie = (versions, extra = {}) => ({ items: [{ key: MOVIE_KEY, itemId: OLD, kind: 'movie', stage: 'ready', reason: { code: 'ready' }, versions, ...extra }] });

test('a version Jellyfin adds to the movie the page shows (its version picker) reloads the page once; the same or fewer never do', async t => {
  let versions = 1;
  const h = setup(t, { hash: `#/details?id=${OLD}&serverId=${SERVER}&context=movies`, type: 'Movie', answers: () => movie(versions) });
  await h.D.update(false);
  h.S.refresh([MOVIE_KEY]);
  await sleep(40);
  assert.equal(h.host.shows.length, 0, 'the same versions read again: nothing');
  versions = 2;
  h.S.refresh([MOVIE_KEY]);
  assert.ok(await until(() => h.host.shows.length === 1), 'a second version arrived: Jellyfin draws its page again');
  assert.equal(h.host.shows[0].detail.isRestored, false);
  await sleep(20);
  assert.equal(h.replays.length, 1);
  const reads = h.statusReads();
  h.S.refresh([MOVIE_KEY]);
  await sleep(40);
  assert.equal(h.statusReads(), reads + 1, 'only the explicit status notification reads again');
  assert.equal(h.host.shows.length, 1, 'one reload per change');
  versions = 1;
  h.S.refresh([MOVIE_KEY]);
  await h.D.update(true);
  await sleep(40);
  assert.equal(h.host.shows.length, 1, 'a version going away is no arrival');
  assert.equal(h.id(), OLD, 'the page never moves for a version');
});

test('a version added to an episode the page shows (Jellyfin 12 groups an episode\'s files) reloads it once', async t => {
  let versions = 1;
  const h = setup(t, { answers: () => episode('ready', { versions }) });
  await h.D.update(false);
  versions = 3;
  h.S.refresh([KEY]);
  assert.ok(await until(() => h.host.shows.length === 1));
  await sleep(40);
  assert.equal(h.host.shows.length, 1);
  assert.equal(h.id(), OLD);
});

// LR-2: the version picker is Jellyfin's own; JE's in-place patches never touch it. After the first
// redraw, a later version (another burst) must reach it through one more coalesced redraw.
const versionPage = (t, kind, versions) => {
  const h = setup(t, kind === 'movie'
    ? { hash: `#/details?id=${OLD}&serverId=${SERVER}&context=movies`, type: 'Movie', answers: () => movie(versions()) }
    : { answers: () => episode('ready', { versions: versions() }) });
  // Jellyfin's controller draws the picker from the item on each show.
  const picker = h.document.createElement('select');
  picker.className = 'selectSource';
  h.view.appendChild(picker);
  const draw = () => picker.replaceChildren(...Array.from({ length: versions() }, (_, n) => {
    const o = h.document.createElement('option');
    o.textContent = `Version ${n + 1}`;
    return o;
  }));
  draw();
  h.view.addEventListener('viewshow', draw);
  return { h, picker };
};

for (const kind of ['movie', 'episode']) {
  test(`${kind}: separate later version bursts each reach Jellyfin's version picker with one redraw per burst`, async t => {
    let versions = 1;
    const { h, picker } = versionPage(t, kind, () => versions);
    await h.D.update(false);
    versions = 2;
    await h.D.update(true);
    assert.ok(await until(() => h.host.shows.length === 1), 'the first burst redraws');
    await sleep(40);
    assert.equal(picker.options.length, 2);
    h.A.timing.batch = 80;
    for (const burst of [[3, 4], [5, 6]]) {
      const before = h.host.shows.length;
      for (const n of burst) {
        versions = n;
        await h.D.update(true);
      }
      assert.equal(h.host.shows.length, before, 'the burst settles first');
      assert.equal(h.A.state().base.versions, burst[0] - 1, 'not recorded as drawn before Jellyfin redraws');
      assert.ok(await until(() => h.host.shows.length === before + 1), 'the later burst redraws the native page');
      await sleep(120);
      assert.equal(h.host.shows.length, before + 1, 'one redraw for the burst');
      assert.equal(picker.options.length, burst[1], 'the picker shows every version');
      assert.equal(h.A.state().base.versions, burst[1]);
    }
    assert.equal(h.replays.length, 3, 'JE page handlers replay once per redraw');
    assert.equal(h.id(), OLD);
  });

  test(`${kind}: a later version waits for the gap and for the viewer's finger before Jellyfin redraws`, async t => {
    let versions = 2;
    const { h, picker } = versionPage(t, kind, () => versions);
    await h.D.update(false);
    versions = 3;
    await h.D.update(true);
    assert.ok(await until(() => h.host.shows.length === 1));
    h.A.timing.gap = 250;
    h.window.dispatchEvent(new h.window.Event('pointerdown'));
    versions = 4;
    await h.D.update(true);
    await sleep(320);
    assert.equal(h.host.shows.length, 1, 'held while the pointer is down');
    assert.equal(picker.options.length, 3);
    assert.equal(h.A.state().base.versions, 3, 'still drawn with three');
    h.window.dispatchEvent(new h.window.Event('pointerup'));
    assert.ok(await until(() => h.host.shows.length === 2, 2000), 'redrawn once released');
    assert.equal(picker.options.length, 4);
  });
}

// LRR-1: Jellyfin's redraw is asynchronous and can fail (its item read errors, the old controls stay).
// A movie or episode change counts as drawn only once Jellyfin's own picker (select.selectSource) lists it.
const asyncVersionPage = (t, kind, versions, fail) => {
  const h = setup(t, kind === 'movie'
    ? { hash: `#/details?id=${OLD}&serverId=${SERVER}&context=movies`, type: 'Movie', answers: () => movie(versions()) }
    : { answers: () => episode('ready', { versions: versions() }) });
  const picker = h.document.createElement('select');
  picker.className = 'selectSource';
  h.view.appendChild(picker);
  const draw = () => picker.replaceChildren(...Array.from({ length: versions() }, () => h.document.createElement('option')));
  draw();
  h.view.addEventListener('viewshow', async () => {
    const failed = fail();
    await Promise.resolve();
    if (!failed) draw();
  });
  return { h, picker };
};

for (const kind of ['movie', 'episode']) {
  test(`${kind}: a later native redraw that fails is tried again and the baseline waits for it (review probe)`, async t => {
    let versions = 1;
    let failNext = false;
    const { h, picker } = asyncVersionPage(t, kind, () => versions, () => { const f = failNext; failNext = false; return f; });
    await h.D.update(false);
    versions = 2;
    await h.D.update(true);
    assert.ok(await until(() => picker.options.length === 2));
    failNext = true;
    versions = 3;
    await h.D.update(true);
    assert.ok(await until(() => h.host.shows.length >= 2));
    await sleep(40);
    for (let n = 0; n < 3; n++) await h.D.update(true);
    await sleep(40);
    assert.equal(picker.options.length, 3, 'fresh status reads recover the failed redraw');
    assert.equal(h.A.state().base.versions, 3);
    assert.equal(h.host.shows.length, 3, 'one retry, no loop');
    h.D.stop(); // leave the followed page; the host keeps the same cached view for Back
    await h.D.update(false);
    await sleep(40);
    assert.equal(picker.options.length, 3, 'a cached-view restore stays reconciled');
    assert.equal(h.host.shows.length, 3);
  });

  test(`${kind}: a native redraw that never takes is tried a bounded number of times, then left until a newer version`, async t => {
    let versions = 2;
    let failing = true;
    const { h, picker } = asyncVersionPage(t, kind, () => versions, () => failing);
    await h.D.update(false);
    versions = 3;
    await h.D.update(true);
    assert.ok(await until(() => h.host.shows.length === h.A.timing.redrawTries), 'retried up to the limit');
    for (let n = 0; n < 4; n++) { await h.D.update(true); await sleep(10); }
    await sleep(60);
    assert.equal(h.host.shows.length, h.A.timing.redrawTries, 'no further redraw for the same change');
    assert.equal(picker.options.length, 2);
    assert.equal(h.A.state().base.versions, 2, 'never recorded as drawn');
    failing = false;
    versions = 4;
    await h.D.update(true);
    assert.ok(await until(() => picker.options.length === 4), 'a newer version gets a fresh redraw');
    assert.ok(await until(() => h.A.state().base.versions === 4), 'drawn once the picker lists it');
    assert.equal(h.host.shows.length, h.A.timing.redrawTries + 1);
  });

  test(`${kind}: a slow native redraw that catches up before the retry needs no second redraw`, async t => {
    let versions = 2;
    const h = setup(t, kind === 'movie'
      ? { hash: `#/details?id=${OLD}&serverId=${SERVER}&context=movies`, type: 'Movie', answers: () => movie(versions) }
      : { answers: () => episode('ready', { versions }) });
    const picker = h.document.createElement('select');
    picker.className = 'selectSource';
    h.view.appendChild(picker);
    const draw = () => picker.replaceChildren(...Array.from({ length: versions }, () => h.document.createElement('option')));
    draw();
    h.view.addEventListener('viewshow', () => { setTimeout(draw, 40); });
    h.A.timing.gap = 150;
    await h.D.update(false);
    versions = 3;
    await h.D.update(true);
    assert.ok(await until(() => h.host.shows.length === 1));
    assert.ok(await until(() => h.A.state().base.versions === 3, 1000), 'drawn once the picker caught up');
    await sleep(200);
    assert.equal(h.host.shows.length, 1, 'no second redraw');
    assert.equal(picker.options.length, 3);
  });
}

// LRR2: a picker the page had, missing at the check (Jellyfin mid-redraw), is not a redraw that took;
// and a version removed while a retry waits must not stay the target or fence a later arrival.
const retryPage = (t, kind) => {
  let versions = 2;
  const h = setup(t, kind === 'movie'
    ? { hash: `#/details?id=${OLD}&serverId=${SERVER}&context=movies`, type: 'Movie', answers: () => movie(versions) }
    : { answers: () => episode('ready', { versions }) });
  Object.assign(h.A.timing, { settle: 15, gap: 140, batch: 25 });
  const picker = h.document.createElement('select');
  picker.className = 'selectSource';
  h.view.appendChild(picker);
  const draw = () => picker.replaceChildren(...Array.from({ length: versions }, () => h.document.createElement('option')));
  draw();
  let render = draw;
  h.view.addEventListener('viewshow', () => render());
  return { h, picker, draw, set: n => { versions = n; }, render: fn => { render = fn; } };
};

for (const kind of ['movie', 'episode']) {
  test(`${kind}: a picker missing while Jellyfin redraws is not counted as drawn (review probe)`, async t => {
    const f = retryPage(t, kind), { h } = f;
    await h.D.update(false);
    // The first redraw takes the picker away and puts the old one back after the check: no item render.
    f.render(() => { if (h.host.shows.length === 1) { f.picker.remove(); setTimeout(() => h.view.appendChild(f.picker), 55); } else f.draw(); });
    f.set(3);
    await h.D.update(true);
    await sleep(100);
    assert.equal(h.A.state().base.versions, 2, 'not recorded as drawn while the picker was missing');
    for (let n = 0; n < 3; n++) await h.D.update(true);
    await sleep(300);
    assert.equal(f.picker.options.length, 3, 'retried once the picker was back');
    assert.equal(h.A.state().base.versions, 3);
    assert.equal(h.host.shows.length, 2, 'one retry');
    h.D.stop();
    await h.D.update(false);
    await sleep(180);
    assert.equal(f.picker.options.length, 3, 'a cached-view restore stays reconciled');
    assert.equal(h.host.shows.length, 2);
  });

  test(`${kind}: a picker that stays missing after the redraw is tried a bounded number of times`, async t => {
    const f = retryPage(t, kind), { h } = f;
    await h.D.update(false);
    f.render(() => { f.picker.remove(); });
    f.set(3);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().abandoned?.versions === 3, 2000), 'given up after the bound');
    for (let n = 0; n < 3; n++) { await h.D.update(true); await sleep(10); }
    await sleep(300);
    assert.equal(h.host.shows.length, h.A.timing.redrawTries, 'no loop');
    assert.equal(h.A.state().base.versions, 2);
  });

  test(`${kind}: a version removed while a failed redraw waits becomes the target, and a later arrival still redraws (review probe)`, async t => {
    const f = retryPage(t, kind), { h } = f;
    await h.D.update(false);
    f.render(() => { if (h.host.shows.length > 1) f.draw(); }); // the first redraw fails
    f.set(4);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().failures?.tries === 1));
    f.set(3); // one version removed while the retry for four waits
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().base.versions === 3), 'the retry draws what is there now');
    assert.equal(f.picker.options.length, 3);
    assert.equal(h.A.state().abandoned, null);
    f.set(4); // a new arrival after the page shows three
    for (let n = 0; n < 3; n++) await h.D.update(true);
    await sleep(350);
    assert.equal(f.picker.options.length, 4, 'the later arrival gets its redraw');
    assert.equal(h.A.state().base.versions, 4);
    assert.equal(h.host.shows.length, 3);
  });

  test(`${kind}: Jellyfin changing the item again gives a given-up redraw one fresh, bounded chance`, async t => {
    const handlers = [];
    let versions = 2;
    const h = setup(t, {
      apiClient: { subscribe: (types, fn) => { handlers.push(fn); return () => {}; } },
      ...(kind === 'movie'
        ? { hash: `#/details?id=${OLD}&serverId=${SERVER}&context=movies`, type: 'Movie', answers: () => movie(versions) }
        : { answers: () => episode('ready', { versions }) })
    });
    Object.assign(h.A.timing, { settle: 15, gap: 60, batch: 25 });
    const picker = h.document.createElement('select');
    picker.className = 'selectSource';
    h.view.appendChild(picker);
    const draw = () => picker.replaceChildren(...Array.from({ length: versions }, () => h.document.createElement('option')));
    draw();
    let failing = true;
    h.view.addEventListener('viewshow', () => { if (!failing) draw(); });
    await h.D.update(false);
    assert.ok(await until(() => handlers.length === 1));
    versions = 3;
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().abandoned?.versions === 3, 2000));
    const shows = h.host.shows.length;
    await h.D.update(true);
    await sleep(150);
    assert.equal(h.host.shows.length, shows, 'the same read again stays given up');
    failing = false;
    handlers[0]({ MessageType: 'LibraryChanged', Data: { ItemsAdded: [], ItemsUpdated: [OLD], ItemsRemoved: [] } });
    await sleep(200);
    assert.equal(h.host.shows.length, shows, 'the item merely updated again is no evidence of other versions');
    // A version replaced by another of the same count: Jellyfin adds and removes items naming the page's item.
    handlers[0]({ MessageType: 'LibraryChanged', Data: { ItemsAdded: [NEW], ItemsUpdated: [OLD], ItemsRemoved: ['ffffffffffffffffffffffffffffffff'] } });
    assert.ok(await until(() => picker.options.length === 3, 2000), 'versions added or removed retries');
    assert.ok(await until(() => h.A.state().base.versions === 3));
    assert.equal(h.host.shows.length, shows + 1);
  });

  // LRR3: the picker the page was shown with can go missing before JE's first redraw; and repeated
  // LibraryChanged notifications must not renew an unchanged failed change without bound.
  const eventPage = (t, kind, initial = 2) => {
    const handlers = [];
    let versions = initial;
    const h = setup(t, {
      apiClient: { subscribe: (types, fn) => { handlers.push(fn); return () => {}; } },
      items: { [OLD]: { Id: OLD, SeasonId: SEASON, SeriesId: SERIES } },
      ...(kind === 'movie'
        ? { hash: `#/details?id=${OLD}&serverId=${SERVER}&context=movies`, type: 'Movie', answers: () => movie(versions) }
        : { answers: () => episode('ready', { versions }) })
    });
    Object.assign(h.A.timing, { settle: 15, gap: 100, batch: 25 });
    const picker = h.document.createElement('select');
    picker.className = 'selectSource';
    h.view.appendChild(picker);
    const draw = () => picker.replaceChildren(...Array.from({ length: versions }, () => h.document.createElement('option')));
    draw();
    let render = draw;
    h.view.addEventListener('viewshow', () => render());
    return { h, picker, draw, set: n => { versions = n; }, render: fn => { render = fn; },
      event: data => handlers[0]({ MessageType: 'LibraryChanged', Data: data }) };
  };

  test(`${kind}: the picker the page was shown with, missing before the first redraw, is not counted as drawn (review probe)`, async t => {
    const f = eventPage(t, kind), { h } = f;
    await h.D.update(false);
    assert.equal(f.picker.options.length, 2);
    f.picker.remove(); // Jellyfin takes its controls away before JE's own redraw
    f.render(() => {});
    f.set(3);
    await h.D.update(true);
    await sleep(55);
    assert.equal(h.A.state().base.versions, 2, 'not drawn while the picker was missing');
    h.view.appendChild(f.picker); // the old two-option controls come back
    f.render(f.draw);
    for (let n = 0; n < 3; n++) await h.D.update(true);
    await sleep(350);
    assert.equal(f.picker.options.length, 3, 'retried once the picker was back');
    assert.equal(h.A.state().base.versions, 3);
    h.D.stop();
    await h.D.update(false);
    await sleep(180);
    assert.equal(f.picker.options.length, 3);
    assert.equal(h.A.state().base.versions, 3);
  });

  test(`${kind}: spaced identical updates of the item never renew an unchanged failed change (review probe)`, async t => {
    const f = eventPage(t, kind), { h } = f;
    await h.D.update(false);
    f.render(() => {});
    f.set(3);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().abandoned?.versions === 3, 2000));
    assert.equal(h.host.shows.length, 3);
    for (let round = 1; round <= 5; round++) {
      f.event({ ItemsUpdated: [OLD] });
      await sleep(400);
    }
    assert.equal(h.host.shows.length, 3, 'no fresh tries for the same change');
    assert.equal(h.A.state().base.versions, 2);
    assert.equal(h.A.state().abandoned?.versions, 3);
  });

  test(`${kind}: a continuous stream of identical item updates stays at one bounded set (review probe)`, async t => {
    const f = eventPage(t, kind), { h } = f;
    await h.D.update(false);
    f.render(() => {});
    f.set(3);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().abandoned?.versions === 3, 2000));
    for (let n = 0; n < 60; n++) { f.event({ ItemsUpdated: [OLD] }); await sleep(20); }
    await sleep(300);
    assert.equal(h.host.shows.length, 3);
    assert.equal(h.replays.length, 3);
    assert.equal(f.picker.options.length, 2);
  });

  test(`${kind}: versions added or removed renew a given-up change at most redrawRenewals times per view`, async t => {
    const f = eventPage(t, kind), { h } = f;
    await h.D.update(false);
    f.render(() => {});
    f.set(3);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().abandoned?.versions === 3, 2000));
    const { redrawTries, redrawRenewals } = h.A.timing;
    for (let round = 1; round <= redrawRenewals + 2; round++) {
      f.event({ ItemsAdded: [NEW], ItemsUpdated: [OLD], ItemsRemoved: ['ffffffffffffffffffffffffffffffff'] });
      const expected = redrawTries * (1 + Math.min(round, redrawRenewals));
      assert.ok(await until(() => h.host.shows.length === expected && h.A.state().abandoned?.versions === 3, 3000), `set ${round}`);
      await sleep(150);
      assert.equal(h.host.shows.length, expected);
    }
    assert.equal(h.host.shows.length, redrawTries * (1 + redrawRenewals), 'bounded per view');
    assert.equal(h.A.state().base.versions, 2);
  });

  test(`${kind}: a given-up change that Jellyfin's returned picker already shows is recorded with no redraw`, async t => {
    const f = eventPage(t, kind), { h } = f;
    await h.D.update(false);
    f.render(() => f.picker.remove());
    f.set(3);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().abandoned?.versions === 3, 2000));
    f.draw();
    h.view.appendChild(f.picker); // Jellyfin's controls come back, already listing all three
    await h.D.update(true);
    assert.equal(h.A.state().base.versions, 3);
    assert.equal(h.A.state().abandoned, null);
    await sleep(200);
    assert.equal(h.host.shows.length, h.A.timing.redrawTries, 'no redraw for it');
  });

  // LRR4: a removal down to one starts the page over; a given-up change fences only its own count.
  const flagged = { ItemsUpdated: [OLD], ItemsAdded: [NEW], ItemsRemoved: ['ffffffffffffffffffffffffffffffff'] };

  test(`${kind}: drawn with two, a removal to one, then a new second version redraws (review probe)`, async t => {
    const f = eventPage(t, kind), { h } = f;
    await h.D.update(false);
    f.set(1); f.draw(); // Jellyfin redrew itself after a version was removed
    await h.D.update(true);
    assert.equal(h.A.state().base.versions, 1, 'starts over at one');
    f.set(2); // the picker stays at one until JE has Jellyfin redraw
    await h.D.update(true);
    f.event(flagged);
    for (let n = 0; n < 3; n++) await h.D.update(true);
    await sleep(450);
    assert.equal(f.picker.options.length, 2, 'a new arrival after an observed removal reaches the picker');
    assert.equal(h.A.state().base.versions, 2);
    assert.equal(h.host.shows.length, 1);
  });

  test(`${kind}: after a removal to one, a picker still listing the removed version doesn't stand in for the redraw`, async t => {
    const f = eventPage(t, kind), { h } = f;
    await h.D.update(false);
    f.set(1); // Jellyfin doesn't redraw for a removal: its picker still lists both old versions
    await h.D.update(true);
    assert.equal(h.A.state().base.versions, 1);
    assert.equal(f.picker.options.length, 2);
    f.set(2); // a new second version: the count matches the stale picker, but Jellyfin must still redraw
    await h.D.update(true);
    assert.ok(await until(() => h.host.shows.length === 1), 'redrawn');
    assert.ok(await until(() => h.A.state().base.versions === 2));
  });

  test(`${kind}: redrawn one → two, a removal to one, then a new second version redraws again (review probe)`, async t => {
    const f = eventPage(t, kind, 1), { h } = f;
    await h.D.update(false);
    f.set(2);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().base.versions === 2));
    assert.equal(h.host.shows.length, 1);
    f.set(1); f.draw();
    await h.D.update(true);
    f.set(2);
    await h.D.update(true);
    f.event(flagged);
    await sleep(450);
    assert.equal(f.picker.options.length, 2);
    assert.equal(h.host.shows.length, 2, 'handled like a first arrival');
    assert.equal(h.A.state().base.versions, 2);
  });

  test(`${kind}: with renewals used up, a lower read and a new arrival are new changes (review probe)`, async t => {
    const f = eventPage(t, kind), { h } = f;
    await h.D.update(false);
    f.render(() => {});
    f.set(5);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().abandoned?.versions === 5, 2500));
    for (let n = 1; n <= h.A.timing.redrawRenewals; n++) {
      f.event(flagged);
      assert.ok(await until(() => h.host.shows.length === 3 * (n + 1) && h.A.state().abandoned?.versions === 5, 2500));
    }
    assert.equal(h.A.state().renewals, h.A.timing.redrawRenewals);
    f.set(3); // a removal is read
    await h.D.update(true);
    await sleep(150);
    assert.equal(h.A.state().abandoned, null, 'the obsolete five no longer fences anything');
    f.render(() => f.draw());
    f.set(4);
    await h.D.update(true);
    for (let n = 0; n < 3; n++) await h.D.update(true);
    await sleep(450);
    assert.equal(f.picker.options.length, 4, 'a genuine new four reaches the picker');
    assert.equal(h.A.state().base.versions, 4);
  });

  test(`${kind}: given up at three with renewals used up, a fourth version still redraws`, async t => {
    const f = eventPage(t, kind), { h } = f;
    await h.D.update(false);
    f.render(() => {});
    f.set(3);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().abandoned?.versions === 3, 2500));
    for (let n = 1; n <= h.A.timing.redrawRenewals; n++) {
      f.event(flagged);
      assert.ok(await until(() => h.host.shows.length === 3 * (n + 1) && h.A.state().abandoned?.versions === 3, 2500));
    }
    await h.D.update(true);
    await sleep(150);
    assert.equal(h.host.shows.length, 12, 'the same count stays given up');
    f.render(() => f.draw());
    f.set(4);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().base.versions === 4, 1500));
    assert.equal(f.picker.options.length, 4);
    assert.equal(h.host.shows.length, 13);
  });

  test(`${kind}: a failed redraw whose change is gone again waits for nothing`, async t => {
    const f = retryPage(t, kind), { h } = f;
    await h.D.update(false);
    f.render(() => { if (h.host.shows.length > 1) f.draw(); });
    f.set(3);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().failures?.tries === 1));
    f.set(2); // the new version went away before the retry
    await h.D.update(true);
    await sleep(300);
    assert.equal(h.host.shows.length, 1, 'no retry for a change that is gone');
    assert.equal(h.A.state().base.versions, 2);
    f.set(3);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().base.versions === 3, 1000));
    assert.equal(f.picker.options.length, 3);
  });
}

test('a movie whose file Jellyfin now keeps as a version of another item moves to that item', async t => {
  // Jellyfin makes the higher resolution the primary: the 1080p item the page showed becomes a version of the
  // new 2160p item (12.x), which the status names.
  const h = setup(t, { hash: `#/details?id=${OLD}&serverId=${SERVER}&context=movies`, type: 'Movie', answers: (path, n) => (n === 1 ? movie(1) : movie(2, { openItemId: NEW })) });
  await h.D.update(false);
  h.S.refresh([MOVIE_KEY]);
  assert.ok(await until(() => h.id() === NEW));
  assert.equal(h.window.location.hash, `#/details?id=${NEW}&serverId=${SERVER}&context=movies`);
  assert.equal(h.host.shows.length, 0, 'moved, not reloaded');
});

test('a season gaining episodes gets one host refresh per view; subsequent arrivals patch in place', async t => {
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
  await sleep(40);
  assert.equal(h.host.shows.length, 1, 'later arrivals leave the same host view in place');
});

test('a season page waits for a burst of arrivals (and Jellyfin tidying up after them) to settle, then reloads once', async t => {
  let ready = 1;
  const handlers = [];
  const h = setup(t, {
    type: 'Season', hash: `#/details?id=${SEASON}&serverId=${SERVER}`,
    apiClient: { subscribe: (types, fn) => { handlers.push(fn); return () => {}; } },
    items: { [SEASON]: { Id: SEASON, Type: 'Season', SeriesId: SERIES } },
    answers: () => season(ready)
  });
  h.A.timing.batch = 200;
  await h.D.update(false);
  assert.ok(await until(() => handlers.length === 1));
  ready = 2;
  h.S.refresh(['tv:tvdb:75932:s1']);
  await sleep(50);
  ready = 3;
  h.S.refresh(['tv:tvdb:75932:s1']);
  await sleep(150);
  // Jellyfin dropped the missing episode the file replaced (the count is the same).
  handlers[0]({ MessageType: 'LibraryChanged', Data: { ItemsRemoved: [OLD], FoldersRemovedFrom: [SEASON] } });
  await sleep(120);
  assert.equal(h.host.shows.length, 0, 'not while it keeps changing');
  assert.ok(await until(() => h.host.shows.length === 1, 1000));
  await sleep(200);
  assert.equal(h.host.shows.length, 1, 'one reload for the burst');
});

test('a later arrival burst in the same view never triggers another host redraw', async t => {
  let ready = 1;
  const h = setup(t, { type: 'Season', hash: `#/details?id=${SEASON}&serverId=${SERVER}`, answers: () => season(ready) });
  await h.D.update(false);
  ready = 2;
  await h.D.update(true);
  assert.ok(await until(() => h.host.shows.length === 1));
  for (ready = 3; ready <= 6; ready++) await h.D.update(true);
  await sleep(40);
  assert.equal(h.host.shows.length, 1);
  assert.equal(h.A.state().base.count, 6, 'accepted availability advances without a redraw');
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

test('a move that waited for the viewer reads its destination again as them right before going, and is dropped when they may no longer open it', async t => {
  let allowed = true;
  const reads = [];
  const h = setup(t, {
    apiClient: {
      getItem: async (user, id) => {
        reads.push({ user, id });
        if (!allowed) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { Id: id };
      }
    },
    answers: (path, n) => (n === 1 ? episode('almostReady') : episode('ready', { itemId: NEW, openItemId: NEW }))
  });
  await h.D.update(false);
  const close = openDialog(h);
  h.S.refresh([KEY]);
  await sleep(40);
  assert.equal(h.id(), OLD, 'held while the dialog is open');
  // Meanwhile an admin takes the library (or a parental rating) away from them.
  allowed = false;
  close();
  assert.ok(await until(() => reads.length === 1));
  await sleep(40);
  assert.equal(h.id(), OLD, 'never sent to an item they can no longer open');
  assert.deepEqual(reads[0], { user: 'user-a', id: NEW }, 'read as the signed-in viewer');
  assert.equal(h.A.state()?.pending ?? null, null, 'the move is dropped');
  await sleep(40);
  assert.equal(reads.length, 1, 'and not tried again by itself');
  // Allowed again: the next read naming it moves the page (checked again first).
  allowed = true;
  h.S.refresh([KEY]);
  assert.ok(await until(() => h.id() === NEW));
  assert.equal(reads.length, 2);
});

test('a destination check that answers after the user changed, the viewer left or opened a dialog never moves the page then', async t => {
  for (const what of ['user', 'left', 'dialog']) {
    await t.test(what, async st => {
      const answers = [];
      const h = setup(st, {
        apiClient: { getItem: (user, id) => new Promise(resolve => answers.push(() => resolve({ Id: id }))) },
        answers: (path, n) => (n === 1 ? episode('almostReady') : episode('ready', { itemId: NEW, openItemId: NEW }))
      });
      await h.D.update(false);
      h.S.refresh([KEY]);
      assert.ok(await until(() => answers.length === 1), 'the destination is read before the move');
      let close = null;
      if (what === 'user') h.session.epoch++;
      else if (what === 'left') h.window.location.hash = `#/details?id=${SERIES}&serverId=${SERVER}`;
      else close = openDialog(h);
      answers.shift()();
      await sleep(40);
      if (what === 'left') {
        assert.equal(h.id(), SERIES, 'never sent back to the old page\'s successor');
        return;
      }
      assert.equal(h.id(), OLD, `no move once ${what === 'user' ? 'the user changed' : 'a dialog opened'}`);
      if (what === 'user') {
        assert.equal(h.A.state(), null, 'the page is forgotten');
        return;
      }
      close();
      assert.ok(await until(() => answers.length === 1), 'read again once the dialog closes');
      answers.shift()();
      assert.ok(await until(() => h.id() === NEW));
    });
  }
});

test('the arrival route is told the series copy the page showed (a 4K copy or the series in another library is another series item)', async t => {
  const items = { [OLD]: { Id: OLD, Type: 'Episode', SeriesId: SERIES, SeasonId: SEASON, LocationType: 'Virtual' } };
  let deleted = false;
  const h = setup(t, {
    items,
    answers: (path) => {
      if (path.startsWith('/acquire/status/arrival')) return { itemId: NEW };
      if (path.includes(SEASON)) return season(2);
      return deleted ? { items: [] } : episode('almostReady');
    }
  });
  await h.D.update(false);
  assert.ok(await until(() => h.itemReads.some(r => r.id === OLD)));
  await sleep(5);
  // Off to the season page while Jellyfin deletes the missing episode (JE's copy of it goes too).
  h.window.location.hash = `#/details?id=${SEASON}&serverId=${SERVER}`;
  await h.D.update(false);
  deleted = true;
  delete items[OLD];
  h.window.location.hash = `#/details?id=${OLD}&serverId=${SERVER}&context=tvshows`;
  await h.D.update(false);
  assert.ok(await until(() => h.id() === NEW));
  assert.equal(h.arrivalReads()[0].path, `/acquire/status/arrival?key=${encodeURIComponent(KEY)}&itemId=${OLD}&seriesId=${SERIES}`, 'remembered with the page\'s key');
});

for (const kind of ['season', 'series']) {
  test(`a ${kind} page Jellyfin restored catches up on episodes that arrived while the viewer was away, once`, async t => {
    const SELF = kind === 'season' ? SEASON : SERIES;
    const OTHER = kind === 'season' ? SERIES : SEASON;
    const selfKey = kind === 'season' ? 'tv:tvdb:75932:s1' : 'tv:tvdb:75932';
    let ready = 2;
    const status = id => (id === SEASON ? season(ready) : series(ready));
    const h = setup(t, {
      type: kind === 'season' ? 'Season' : 'Series', hash: `#/details?id=${SELF}&serverId=${SERVER}`,
      answers: path => status(path.includes(SELF) ? SELF : OTHER)
    });
    h.A.timing.batch = 20;
    await h.D.update(false);
    // To the other page (Jellyfin keeps this one, hidden), where episodes arrive.
    h.view.classList.add('hide');
    h.document.body.insertAdjacentHTML('beforeend', page(kind === 'season' ? 'Series' : 'Season'));
    const other = [...h.document.querySelectorAll('#itemDetailPage')].pop();
    h.window.location.hash = `#/details?id=${OTHER}&serverId=${SERVER}`;
    await h.D.update(false);
    ready = 4;
    await sleep(40);
    assert.equal(h.host.shows.length, 0);
    // Back: Jellyfin restores the page as it was drawn (2 ready) without reading it again.
    other.classList.add('hide');
    h.view.classList.remove('hide');
    h.window.location.hash = `#/details?id=${SELF}&serverId=${SERVER}`;
    await h.D.update(false);
    assert.ok(await until(() => h.host.shows.length === 1), 'Jellyfin redraws it with what arrived');
    // Its own reads after the redraw, and more of them, are no new arrival: no loop.
    h.S.refresh([selfKey]);
    h.S.refresh([selfKey]);
    await sleep(80);
    assert.equal(h.host.shows.length, 1);
    // A page Jellyfin draws afresh for the same item shows what is there: nothing to catch up.
    h.view.remove();
    h.document.body.insertAdjacentHTML('beforeend', page(kind === 'season' ? 'Season' : 'Series'));
    const fresh = [...h.document.querySelectorAll('#itemDetailPage')].pop();
    let freshShows = 0;
    fresh.addEventListener('viewshow', () => { freshShows++; });
    other.remove();
    ready = 5;
    await h.D.update(true);
    await sleep(80);
    assert.equal(freshShows, 0);
  });
}

/** Controlled realm time: deadlines never depend on the host event loop. */
function virtualClock(h) {
  let now = 100000;
  let serial = 0;
  const timers = new Map();
  const NativeDate = h.window.Date;
  h.window.Date = class extends NativeDate { static now() { return now; } };
  h.window.setTimeout = (fn, wait = 0, ...args) => {
    const id = ++serial;
    timers.set(id, { at: now + Math.max(0, wait), fn: () => fn(...args) });
    return id;
  };
  h.window.clearTimeout = id => timers.delete(id);
  return {
    get now() { return now; },
    advance(ms) {
      const target = now + ms;
      let count = 0;
      for (;;) {
        const next = [...timers.entries()].filter(([,v]) => v.at <= target).sort((a,b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++count < 10000, 'finite scheduled work');
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.fn();
      }
      now = target;
    }
  };
}
/** A season page drawn with one ready episode before an arrival. */
function makeSeason(t, options = {}) {
  return setup(t, { type: 'Season', hash: `#/details?id=${SEASON}&serverId=${SERVER}`, answers: () => season(1), ...options });
}
/** Deliver the real arrival rule a status accepted for the current page. */
const notice = (h, ready) => h.A.seen(h.view, SEASON, season(ready).items[0]);
/** A status response whose completion is controlled by the test. */
const deferredAnswer = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test('virtual: same-count reads preserve the original settle deadline', async t => {
  const h = makeSeason(t);
  const clock = virtualClock(h);
  Object.assign(h.A.timing, { batch: 120, batchMax: 2000, settle: 10000 });
  await h.D.update(false);
  notice(h, 2);
  const since = h.A.state().pending.since;
  for (let time = 20; time <= 100; time += 20) {
    clock.advance(20);
    notice(h, 2);
    assert.equal(h.A.state().pending.since, since);
    assert.equal(h.host.shows.length, 0);
  }
  clock.advance(19);
  assert.equal(h.host.shows.length, 0);
  clock.advance(1);
  assert.equal(h.host.shows.length, 1, 'same-count reads do not postpone the 120 ms reload');
});

test('virtual: increasing counts restart settle but preserve the absolute cap', async t => {
  const h = makeSeason(t);
  const clock = virtualClock(h);
  Object.assign(h.A.timing, { batch: 120, batchMax: 300, settle: 10000 });
  await h.D.update(false);
  notice(h, 2);
  for (let time = 40; time <= 280; time += 40) {
    clock.advance(40);
    notice(h, 2 + time / 40);
    assert.equal(h.host.shows.length, 0);
  }
  clock.advance(19);
  assert.equal(h.host.shows.length, 0);
  clock.advance(1);
  assert.equal(h.host.shows.length, 1, 'reload exactly at the cap while counts are still changing');
});

test('virtual: an already-pending cap fires while a status read never answers', async t => {
  let slow = false;
  const answer = deferredAnswer();
  const h = makeSeason(t, { answers: () => slow ? answer.promise : season(1) });
  const clock = virtualClock(h);
  Object.assign(h.A.timing, { batch: 120, batchMax: 300, settle: 10000 });
  await h.D.update(false);
  notice(h, 2);
  slow = true;
  const reading = h.D.update(true);
  for (let time = 40; time <= 280; time += 40) {
    clock.advance(40);
    notice(h, 2 + time / 40);
  }
  assert.equal(h.A.state().checking, false, 'status loading is not arrival.checking');
  clock.advance(20);
  assert.equal(h.host.shows.length, 1, 'in-flight status read cannot hold an armed cap');
  answer.resolve(season(10));
  await reading;
});

test('virtual: LibraryChanged removal bursts preserve the cap while their probe is unresolved', async t => {
  const h = makeSeason(t);
  const clock = virtualClock(h);
  Object.assign(h.A.timing, { batch: 120, batchMax: 300, settle: 10000, probe: 5 });
  await h.D.update(false);
  let probes = 0;
  h.JE.internals.arrStatusDetails.update = () => { probes++; return new Promise(() => {}); };
  const removed = () => h.window.ApiClient._callbacks.message.forEach(cb => cb(null, { MessageType: 'LibraryChanged', Data: { FoldersRemovedFrom: [SEASON] } }));
  removed();
  const since = h.A.state().pending.since;
  for (let time = 40; time <= 280; time += 40) {
    clock.advance(40);
    removed();
    assert.equal(h.A.state().pending.since, since);
    assert.equal(h.host.shows.length, 0);
  }
  assert.ok(probes > 0);
  assert.equal(h.A.state().checking, false);
  clock.advance(20);
  assert.equal(h.host.shows.length, 1);
});

/** Drain the finite promise chain from feed position through rendering and a trailing read. */
async function drain() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

test('slow status answers keep applying during refreshes every 20 ms and arrival reloads the page', async t => {
  let slow = false;
  let aborted = 0;
  // The season's "2 of 6 ready" count shows each answer (D92: an opt-in setting).
  const h = makeSeason(t, { config: { ArrStatusSeasonSummaryEnabled: true }, answers: (path, n, options) => {
    if (!slow) return season(1);
    return new Promise(resolve => {
      const onAbort = () => {
        aborted++;
        h.window.clearTimeout(timer);
        resolve(null);
      };
      const timer = h.window.setTimeout(() => {
        options.signal.removeEventListener('abort', onAbort);
        resolve(season(2));
      }, 80);
      options.signal.addEventListener('abort', onAbort, { once: true });
    });
  } });
  const clock = virtualClock(h);
  Object.assign(h.A.timing, { batch: 120, batchMax: 300, settle: 10000 });
  await h.D.update(false);
  slow = true;
  h.S.refresh(['tv:tvdb:75932:s1']);
  await drain();
  for (let time = 20; time <= 400; time += 20) {
    clock.advance(20);
    await drain();
    h.S.refresh(['tv:tvdb:75932:s1']);
    await drain();
    if (time === 80) {
      assert.equal(h.A.state().pending?.base.count, 2, 'the first slow answer reaches arrival while refreshes continue');
      assert.match(h.view.querySelector('.je-arr-summary').textContent, /2 of 6/);
    }
    if (time === 200) assert.equal(h.host.shows.length, 1, 'arrival reloads exactly 120 ms after the first answer');
  }
  assert.equal(h.host.shows.length, 1);
  assert.equal(aborted, 0, 'same-page refreshes never abort the active read');
  assert.equal(h.statusReads(), 7, 'one baseline and one read per 80 ms, rather than one per event');
  h.D.stop();
  await drain();
});

test('a burst during one read produces exactly one trailing read, including a failed active read', async t => {
  for (const fails of [false, true]) {
    const answers = [];
    const h = makeSeason(t, { answers: () => {
      const answer = deferredAnswer();
      answers.push(answer);
      return answer.promise;
    } });
    virtualClock(h);
    const first = h.D.update(false);
    await drain();
    answers[0].resolve(season(1));
    await first;
    const active = h.D.update(true);
    await drain();
    for (let i = 0; i < 10; i++) h.S.refresh(['tv:tvdb:75932:s1']);
    await drain();
    assert.equal(answers.length, 2, 'burst shares the active read');
    answers[1].resolve(fails ? null : season(2));
    await drain();
    assert.equal(answers.length, 3, 'one trailing read catches changes during the active read');
    answers[2].resolve(season(3));
    await active;
    await drain();
    assert.equal(answers.length, 3, 'no further read without a new refresh');
    h.D.stop();
  }
});

for (const change of ['item', 'page', 'user', 'epoch', 'server']) {
  test(`a ${change} change cancels immediately and drops a late status answer and its queued refresh`, async t => {
    const answer = deferredAnswer();
    let slow = false;
    let user = 'user-a';
    const h = makeSeason(t, { apiClient: { getCurrentUserId: () => user }, answers: () => slow ? answer.promise : season(1) });
    const clock = virtualClock(h);
    h.JE.initializeArrStatusDetails();
    await h.D.update(false);
    slow = true;
    const reading = h.D.update(true);
    await drain();
    const signal = h.calls.at(-1).options.signal;
    h.S.refresh(['tv:tvdb:75932:s1']);
    await drain();
    if (change === 'item') h.window.location.hash = `#/details?id=${SERIES}&serverId=${SERVER}`;
    if (change === 'page') {
      h.view.classList.add('hide');
      h.document.body.insertAdjacentHTML('beforeend', page('Season'));
    }
    if (change === 'user') {
      user = 'user-b';
      h.session.epoch++;
      h.userChange.forEach(fn => fn());
    }
    if (change === 'epoch') h.session.epoch++;
    if (change === 'server') h.window.location.hash = `#/details?id=${SEASON}&serverId=another-server`;
    h.navigations.forEach(fn => fn());
    h.views.forEach(fn => fn());
    assert.equal(signal.aborted, true, 'cancellation does not wait for the delayed page look');
    answer.resolve(season(2)); // Fixture intentionally ignores abort: late answers must still be rejected.
    await reading;
    await drain();
    clock.advance(120);
    assert.equal(h.host.shows.length, 0, 'late answer never arms arrival');
    assert.equal(h.statusReads(), 2, 'old queued refresh is discarded');
    assert.doesNotMatch(h.document.body.textContent, /2 of 6/);
    h.D.stop();
  });
}

test('an identity change without a page notification still drops a late answer', async t => {
  let server = SERVER;
  let slow = false;
  const answer = deferredAnswer();
  const h = makeSeason(t, { apiClient: { serverId: () => server }, answers: () => slow ? answer.promise : season(1) });
  const clock = virtualClock(h);
  await h.D.update(false);
  slow = true;
  const reading = h.D.update(true);
  await drain();
  const signal = h.calls.at(-1).options.signal;
  h.S.refresh(['tv:tvdb:75932:s1']);
  await drain();
  server = 'another-api-server';
  answer.resolve(season(2));
  await reading;
  clock.advance(120);
  assert.equal(signal.aborted, true);
  assert.equal(h.host.shows.length, 0);
  assert.equal(h.statusReads(), 2);
  assert.doesNotMatch(h.view.textContent, /2 of 6/);
});

// Phase 2 F41: the status names its set of versions (`versionsFingerprint`: the server's stable hash of the version
// ids and file sizes), so a removal and an arrival that keep the count are a change of their own, and a redraw for one
// counts as drawn only once Jellyfin's picker lists other versions than it did (its option values: media source ids).
const fingerprint = ids => `fp:${ids.join('+')}`;
const setPage = (t, kind, initial = ['a', 'b']) => {
  const handlers = [];
  let ids = [...initial];
  const answer = () => (kind === 'movie' ? movie(ids.length, { versionsFingerprint: fingerprint(ids) }) : episode('ready', { versions: ids.length, versionsFingerprint: fingerprint(ids) }));
  const h = setup(t, {
    apiClient: { subscribe: (types, fn) => { handlers.push(fn); return () => {}; } },
    ...(kind === 'movie' ? { hash: `#/details?id=${OLD}&serverId=${SERVER}&context=movies`, type: 'Movie', answers: answer } : { answers: answer })
  });
  Object.assign(h.A.timing, { settle: 15, gap: 60, batch: 25 });
  const picker = h.document.createElement('select');
  picker.className = 'selectSource';
  h.view.appendChild(picker);
  const draw = () => picker.replaceChildren(...ids.map(id => { const o = h.document.createElement('option'); o.value = id; o.textContent = id; return o; }));
  draw();
  let render = draw;
  h.view.addEventListener('viewshow', () => render());
  return { h, picker, draw, set: next => { ids = [...next]; }, render: fn => { render = fn; }, shown: () => [...picker.options].map(o => o.value),
    event: data => handlers[0]({ MessageType: 'LibraryChanged', Data: data }) };
};

for (const kind of ['movie', 'episode']) {
  test(`F41 ${kind}: a removal and an arrival that keep the count redraw Jellyfin's picker to the new set`, async t => {
    const f = setPage(t, kind), { h } = f;
    await h.D.update(false);
    f.set(['a', 'c']); // B removed, C arrived: still two
    await h.D.update(true);
    assert.ok(await until(() => h.host.shows.length === 1, 2000), 'the other set is a change: Jellyfin redraws');
    assert.ok(await until(() => h.A.state().base.set === fingerprint(['a', 'c']), 2000));
    assert.deepEqual(f.shown(), ['a', 'c']);
    await h.D.update(true);
    await sleep(150);
    assert.equal(h.host.shows.length, 1, 'once');
  });

  test(`F41 ${kind}: a redraw for another set that leaves the old picker (same count) is not drawn; it is tried again, bounded`, async t => {
    const f = setPage(t, kind), { h } = f;
    await h.D.update(false);
    f.render(() => {}); // Jellyfin's redraw fails: the picker still lists A and B
    f.set(['a', 'c']);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().failures?.tries === 1, 2000), 'not drawn: the picker lists the old ids');
    assert.equal(h.A.state().base.set, fingerprint(['a', 'b']));
    f.render(f.draw);
    for (let n = 0; n < 3; n++) await h.D.update(true);
    assert.ok(await until(() => h.A.state().base.set === fingerprint(['a', 'c']), 2000), 'the retry draws it');
    assert.deepEqual(f.shown(), ['a', 'c']);
    assert.equal(h.host.shows.length, 2);

    // Always failing: given up after redrawTries, and add/remove notices don't renew it (the fingerprint says the set).
    f.render(() => {});
    f.set(['a', 'd']);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().abandoned?.set === fingerprint(['a', 'd']), 3000), 'given up after the bound');
    const shows = h.host.shows.length;
    assert.equal(shows, 2 + h.A.timing.redrawTries);
    for (let n = 0; n < 3; n++) f.event({ ItemsAdded: [NEW], ItemsUpdated: [OLD], ItemsRemoved: ['ffffffffffffffffffffffffffffffff'] });
    await sleep(300);
    assert.equal(h.host.shows.length, shows, 'no renewal from LibraryChanged with a fingerprint');
    assert.equal(h.A.state().renewals, 0);
    // A read of yet another set is a change of its own, with its own tries.
    f.render(f.draw);
    f.set(['a', 'e']);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().base.set === fingerprint(['a', 'e']), 2000));
    assert.deepEqual(f.shown(), ['a', 'e']);
  });

  test(`F41 ${kind}: after a removal down to one, a stale two-option picker is not the redraw for a new second version (LRR4-1 limit)`, async t => {
    const f = setPage(t, kind), { h } = f;
    await h.D.update(false);
    f.set(['a']); // B removed: Jellyfin doesn't redraw its page for a removal, its picker still lists A and B
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().base.versions === 1));
    assert.deepEqual(f.shown(), ['a', 'b']);
    f.render(() => {}); // the redraw for C fails
    f.set(['a', 'c']);
    await h.D.update(true);
    assert.ok(await until(() => h.A.state().failures?.tries === 1, 2000), 'the stale picker (two options) is not taken for A and C');
    assert.equal(h.A.state().base.versions, 1);
    f.render(f.draw);
    for (let n = 0; n < 3; n++) await h.D.update(true);
    assert.ok(await until(() => h.A.state().base.set === fingerprint(['a', 'c']), 2000));
    assert.deepEqual(f.shown(), ['a', 'c']);
  });
}
