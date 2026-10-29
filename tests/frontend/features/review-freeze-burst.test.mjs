import { clickAsViewer } from '../helpers/harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHarness, deferred, jsonResponse } from '../helpers/harness.mjs';

const base = 'tv:tvdb:1';
const id = n => String(n).padStart(32, '0');
const turn = async () => { for (let n = 0; n < 5; n++) await new Promise(r => setImmediate(r)); };

function fixture(t, kind = 'season') {
  let now = 100000, serial = 0, stage = 'downloading', ready = 0;
  const timers = new Map(), feed = [], calls = [], body = [], nav = [], replays = [];
  const counters = { queries: 0, styles: 0, creates: 0, removedBlocks: 0, removedArtwork: 0, timerCreates: 0, intervals: 0, applies: 0 };
  const pageId = id(kind === 'episode' ? 1 : kind === 'season' ? 100 : 200);
  const rows = Array.from({ length: 6 }, (_, n) => `<div class="listItem" data-type="Episode" data-id="${id(n + 1)}"><div class="listItemImage"></div><div class="listItemBody"><div class="listItemMediaInfo" style="display:none"></div><a class="listItem-bottomoverview">Episode ${n + 1}</a></div></div>`).join('');
  function status() {
    return { itemId: pageId, key: kind === 'series' ? base : kind === 'season' ? `${base}:s1` : `${base}:s1:e1`, kind,
      stage: ready === 6 ? 'ready' : stage, reason: { code: ready === 6 ? 'ready' : stage === 'almostReady' ? 'importing' : 'downloading' },
      progress: stage === 'downloading' ? { percent: 50 } : null,
      summary: kind === 'episode' ? undefined : { aired: 6, ready, downloading: stage === 'downloading' ? 6 - ready : 0, almostReady: stage === 'almostReady' ? 6 - ready : 0 },
      journey: ['asked', 'downloading', 'almostReady', 'ready'].map(s => ({ stage: s, state: s === stage ? 'current' : 'next' })),
      episodes: kind !== 'season' ? undefined : Array.from({ length: 6 }, (_, n) => ({ itemId: id(n + 1), key: `${base}:s1:e${n + 1}`, episode: n + 1, row: true, stage: n < ready ? 'ready' : stage, reason: { code: n < ready ? 'ready' : stage === 'almostReady' ? 'importing' : 'downloading' }, progress: { percent: 50 } })) };
  }
  const h = createHarness({
    html: `<div id="itemDetailPage" class="page libraryPage" data-type="${kind}"><div class="detailImageContainer"><div class="cardImageContainer"></div></div><div class="detailImageContainer"><div class="cardImageContainer"></div></div><div class="detailPagePrimaryContent"><div class="detailSection"></div></div><div class="itemsContainer">${kind === 'season' ? rows : ''}</div></div>`,
    url: `http://jellyfin.test/web/index.html#/details?id=${pageId}`,
    fetch: (_url, init) => {
      const d = deferred(); const call = { body: JSON.parse(init.body), d, aborted: false, done: false }; feed.push(call);
      init.signal?.addEventListener('abort', () => { call.aborted = true; d.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      return d.promise;
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrStatusArtworkProgressEnabled: true, ArrStatusPosterBadges: true },
      t: (s, p) => s + (p ? JSON.stringify(p) : ''),
      helpers: {
        debounce: (fn, wait) => { let timer; return (...args) => { h.window.clearTimeout(timer); timer = h.window.setTimeout(() => fn(...args), wait); }; },
        onBodyMutation: (_name, fn) => { body.push(fn); return { unsubscribe() {} }; },
        getItemCached: async () => null
      },
      core: { api: { plugin: async path => { calls.push(path); return { items: [status()] }; } },
        navigation: { onNavigate: fn => { nav.push(fn); return () => {}; }, onViewPage: () => () => {}, replayViewShow: () => replays.push(now) },
        lifecycle: { register: () => ({ track: x => x }) } },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} }
    }
  });
  const Date0 = h.window.Date;
  h.window.Date = class extends Date0 { static now() { return now; } };
  h.window.setTimeout = (fn, wait = 0) => { counters.timerCreates++; const n = ++serial; timers.set(n, { at: now + wait, fn }); return n; };
  h.window.clearTimeout = n => timers.delete(n);
  h.window.setInterval = () => { counters.intervals++; throw new Error('Unexpected interval'); };
  for (const proto of [h.window.Document.prototype, h.window.Element.prototype]) {
    for (const name of ['querySelector', 'querySelectorAll']) { const fn = proto[name]; proto[name] = function (...args) { counters.queries++; return fn.apply(this, args); }; }
  }
  const computed = h.window.getComputedStyle;
  h.window.getComputedStyle = (...args) => { counters.styles++; return computed(...args); };
  for (const name of ['createElement', 'createElementNS']) { const fn = h.document[name]; h.document[name] = function (...args) { counters.creates++; return fn.apply(this, args); }; }
  const remove = h.window.Element.prototype.remove;
  h.window.Element.prototype.remove = function () { if (this.classList.contains('je-arr-status')) counters.removedBlocks++; if (this.classList.contains('je-arr-art')) counters.removedArtwork++; return remove.call(this); };
  Object.defineProperty(h.document, 'visibilityState', { get: () => 'visible' });
  for (const file of ['arr/live/arr-live.js', 'arr/status/status-core.js', 'arr/status/status-episodes.js', 'arr/status/status-arrival.js', 'arr/status/status-details.js']) h.load(file);
  const observer = new h.window.MutationObserver(records => { for (const fn of body) { counters.applies++; fn(records); } });
  observer.observe(h.document.body, { childList: true, subtree: true });
  t.after(() => { observer.disconnect(); h.JE.internals.arrStatusDetails.stop(); h.close(); });
  h.JE.arr.live.seed('epoch', 0);
  return { ...h, calls, feed, timers, counters, nav, replays, pageId, status,
    async advance(ms) {
      const target = now + ms;
      for (let n = 0; ; n++) {
        assert.ok(n < 2000, 'bounded timers');
        const next = [...timers].filter(([, v]) => v.at <= target).sort((a,b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [timerId, timer] = next; now = timer.at; timers.delete(timerId); timer.fn(); await turn();
      }
      now = target; await turn();
    },
    async change(changes, nextStage = stage, nextReady = ready) {
      stage = nextStage; ready = nextReady;
      const call = [...feed].reverse().find(c => !c.done && !c.aborted);
      assert.ok(call, 'poll is open'); call.done = true;
      // The server expands episode changes to their season and series (ArrChangeDetector.Expand).
      call.d.resolve(jsonResponse({ epoch: 'epoch', cursor: call.body.cursor + 1, keys: [...new Set([...changes, `${base}:s1`, base])] })); await turn();
    },
    reset() { for (const p in counters) counters[p] = 0; calls.length = 0; },
  };
}

for (const kind of ['season', 'episode', 'series']) test(`review: ${kind} handles six sibling changes in one poll versus six polls`, async t => {
  const h = fixture(t, kind);
  await h.JE.internals.arrStatusDetails.update(false); await h.advance(500); h.reset();
  await h.change(Array.from({ length: 6 }, (_, n) => `${base}:s1:e${n + 1}`));
  await h.advance(200);
  const combined = { reads: h.calls.length, ...h.counters };
  assert.equal(combined.reads, 1);
  h.reset(); const samples = [];
  for (let n = 1; n <= 6; n++) {
    const start = performance.now(); await h.change([`${base}:s1:e${n}`]); samples.push(performance.now() - start); await h.advance(200);
  }
  assert.equal(h.calls.length, 6);
  assert.equal(h.counters.creates, 0);
  assert.equal(h.counters.removedBlocks + h.counters.removedArtwork, 0);
  assert.equal(h.counters.intervals, 0);
  t.diagnostic(JSON.stringify({ kind, combined, separate: { reads: h.calls.length, ...h.counters }, changeTaskAndMicrotasksMs: samples.map(v => +v.toFixed(2)) }));
});

test('regression F1: six spaced arrivals share one host refresh and reuse accepted status', async t => {
  const h = fixture(t);
  let shows = 0;
  h.document.getElementById('itemDetailPage').addEventListener('viewshow', () => shows++);
  await h.JE.internals.arrStatusDetails.update(false); await h.advance(500); h.reset();
  for (let n = 1; n <= 6; n++) { await h.change([`${base}:s1:e${n}`], 'almostReady', n); await h.advance(20000); }
  assert.equal(shows, 1); assert.equal(h.replays.length, 1); assert.equal(h.calls.length, 6);
  t.diagnostic(JSON.stringify({ shows, replays: h.replays.length, reads: h.calls.length, ...h.counters }));
});

test('regression F5: leaving a season cancels arrival timers immediately', async t => {
  const h = fixture(t);
  await h.JE.internals.arrStatusDetails.update(false); await h.advance(500);
  const arrival = h.JE.internals.arrStatusArrival.state();
  h.JE.internals.arrStatusArrival.seen(h.document.getElementById('itemDetailPage'), h.pageId, { kind: 'season', stage: 'almostReady', summary: { ready: 1 } });
  assert.ok(arrival.timer);
  h.window.history.replaceState(null, '', '#/home');
  h.nav.forEach(fn => fn()); await turn();
  h.JE.internals.arrStatusDetails.stop(); // The initialized details navigation hook does this immediately.
  assert.equal(h.JE.internals.arrStatusArrival.state(), null);
  assert.ok(!h.timers.has(arrival.timer));
  await h.advance(6000);
  assert.equal(h.JE.internals.arrStatusArrival.state(), null);
});

test('regression F3/F4: changed chips retain artwork and avoid repeated style reads', async t => {
  const h = fixture(t);
  const page = h.document.getElementById('itemDetailPage');
  const D = h.JE.internals.arrStatusDetails;
  D.render(page, h.status(), {}); await turn(); h.reset();
  const timings = [];
  for (let n = 0; n < 24; n++) {
    const s = h.status();
    if (n % 2 === 0) { s.stage = 'almostReady'; s.summary.downloading = 0; s.summary.almostReady = 6; for (const ep of s.episodes) { ep.stage = 'almostReady'; ep.reason.code = 'importing'; } }
    const start = performance.now(); D.render(page, s, {}); timings.push(performance.now() - start);
  }
  assert.equal(h.counters.styles, 0);
  t.diagnostic(JSON.stringify({ synchronousRenderMs: { min: +Math.min(...timings).toFixed(2), max: +Math.max(...timings).toFixed(2), mean: +(timings.reduce((a,b) => a+b, 0) / timings.length).toFixed(2) }, renders: timings.length, ...h.counters }));
});

test('regression F2: sibling progress reuses season request rows', async t => {
  const h = fixture(t);
  const reads = [];
  h.JE.arrAsk = { enabled: () => true, call: async path => { reads.push(path); return { status: 200, body: { rows: { displayMissing: false, episodes: [] } } }; }, me: async () => null, onChange: () => () => {} };
  h.load('arr/ask/ask-episodes.js'); h.JE.initializeArrAskEpisodes();
  await h.JE.internals.arrStatusDetails.update(false); await h.advance(500); reads.length = 0; h.reset();
  for (let n = 1; n <= 6; n++) { await h.change([`${base}:s1:e${n}`]); await h.advance(200); }
  assert.equal(h.calls.length, 6); assert.equal(reads.length, 0);
  t.diagnostic(JSON.stringify({ statusReads: h.calls.length, seasonRowReads: reads.length, ...h.counters }));
});

test('review: replacing subscriptions rapidly aborts old polls without a second polling chain', async t => {
  const h = fixture(t, 'episode');
  let off = h.JE.arr.onStatusChange(['movie:tmdb:1'], () => {});
  await h.advance(500);
  for (let n = 2; n <= 15; n++) {
    off(); off = h.JE.arr.onStatusChange([`movie:tmdb:${n}`], () => {}); await h.advance(100);
    assert.equal(h.feed.filter(c => !c.done && !c.aborted).length, 1);
  }
  const before = h.feed.length; off(); await h.advance(5000);
  assert.equal(h.feed.length, before);
  assert.equal(h.timers.size, 0);
  t.diagnostic(JSON.stringify({ polls: h.feed.length, cancelled: h.feed.filter(c => c.aborted).length, timersAfterFinalUnsubscribe: h.timers.size }));
});

test('regression F3: sibling updates retain the focused pill, journey and both artwork trees', async t => {
  const h = fixture(t, 'episode');
  await h.JE.internals.arrStatusDetails.update(false); await h.advance(500);
  const pill = h.document.querySelector('.je-arr-pill');
  const journey = h.document.querySelector('.je-arr-journey');
  const art = [...h.document.querySelectorAll('.je-arr-art')];
  pill.focus(); clickAsViewer(pill); h.reset();
  for (let n = 1; n <= 6; n++) { await h.change([`${base}:s1:e${n}`]); await h.advance(200); }
  assert.equal(h.document.activeElement, pill);
  assert.equal(h.document.querySelector('.je-arr-journey'), journey);
  assert.ok(journey.hidden, 'viewer collapse remains');
  assert.deepEqual([...h.document.querySelectorAll('.je-arr-art')], art);
  assert.equal(h.counters.creates, 0);
  assert.equal(h.counters.removedBlocks + h.counters.removedArtwork, 0);
  await h.change([`${base}:s1:e2`], 'almostReady'); await h.advance(200);
  assert.equal(h.document.querySelector('.je-arr-pill'), pill);
  assert.equal(h.document.querySelector('.je-arr-journey'), journey);
  assert.deepEqual([...h.document.querySelectorAll('.je-arr-art')], art);
  clickAsViewer(pill); assert.ok(!journey.hidden, 'retained listener operates the retained journey');
});

for (const interaction of ['pointer', 'touch', 'scroll']) test(`regression F1: ${interaction} activity holds the coalesced refresh`, async t => {
  const h = fixture(t);
  const view = h.document.getElementById('itemDetailPage');
  let shows = 0; view.addEventListener('viewshow', () => shows++);
  await h.JE.internals.arrStatusDetails.update(false); await h.advance(500);
  if (interaction !== 'scroll') h.window.dispatchEvent(new h.window.Event(`${interaction}${interaction === 'pointer' ? 'down' : 'start'}`));
  await h.change([`${base}:s1:e1`], 'almostReady', 1);
  if (interaction === 'scroll') {
    await h.advance(5900); h.window.dispatchEvent(new h.window.Event('scroll')); await h.advance(100);
  } else await h.advance(6000);
  assert.equal(shows, 0, 'no host redraw under an active finger or scroll');
  if (interaction !== 'scroll') h.window.dispatchEvent(new h.window.Event(`${interaction}${interaction === 'pointer' ? 'up' : 'end'}`));
  await h.advance(1500);
  assert.equal(shows, 1);
});

test('regression F1: a native row keeps its click target as the missing item gains a playable replacement', async t => {
  const h = fixture(t);
  const page = h.document.getElementById('itemDetailPage');
  const D = h.JE.internals.arrStatusDetails;
  const row = page.querySelector('.listItem');
  row.innerHTML += `<a href="#/details?id=${id(1)}">Open episode</a><span class="missingIndicator">Missing</span>`;
  const link = row.querySelector('a[href]');
  D.render(page, h.status(), {});
  // SRD-R2: the row is pointed at the playable item once the viewer's read of it answers (one transaction).
  h.JE.helpers.getItemCached = async itemId => ({ Id: itemId, Name: 'Episode 1' });
  const answer = h.status(); answer.episodes[0].stage = 'ready'; answer.episodes[0].reason.code = 'ready'; answer.episodes[0].itemId = id(501);
  D.render(page, answer, {}); await turn();
  assert.equal(page.querySelector('.listItem'), row);
  assert.equal(row.querySelector('a[href]'), link);
  assert.equal(row.dataset.id, id(501));
  assert.ok(link.getAttribute('href').includes(id(501)));
  assert.equal(row.querySelector('.je-arr-chip, .missingIndicator'), null);
});

test('regression F4: owned mutations cause no native-row rescan; host rows still get decorated', async t => {
  const h = fixture(t);
  const page = h.document.getElementById('itemDetailPage');
  h.JE.internals.arrStatusDetails.render(page, h.status(), {}); await turn(); await h.advance(100);
  let scans = 0;
  const query = page.querySelectorAll.bind(page);
  page.querySelectorAll = selector => { if (selector === '.listItem[data-id]') scans++; return query(selector); };
  page.querySelector('.listItemImage').appendChild(h.document.createElement('span'));
  await turn(); await h.advance(100);
  assert.equal(scans, 0);
  const row = page.querySelector('.listItem'); row.querySelector('.je-arr-chip-row').remove();
  row.replaceWith(row.cloneNode(true)); await turn(); await h.advance(100);
  assert.equal(scans, 1);
  assert.ok(page.querySelector('.listItem .je-arr-chip'));
});

test('regression F2: availability, explicit request changes and TTL refresh rows, progress does not', async t => {
  const h = fixture(t);
  const reads = [], changes = [];
  h.JE.arrAsk = { enabled: () => true, call: async path => { reads.push(path); return { status: 200, body: { rows: { displayMissing: false, episodes: [] } } }; }, me: async () => null, onChange: fn => { changes.push(fn); return () => {}; } };
  h.load('arr/ask/ask-episodes.js'); h.JE.initializeArrAskEpisodes();
  await h.JE.internals.arrStatusDetails.update(false); await h.advance(500);
  const initial = reads.length;
  await h.change([`${base}:s1:e1`]); await h.advance(200);
  assert.equal(reads.length, initial);
  changes.forEach(fn => fn()); await turn();
  assert.equal(reads.length, initial + 1);
  await h.advance(60001); await h.change([`${base}:s1:e1`]); await h.advance(200);
  assert.equal(reads.length, initial + 2);
  const s = h.status(); s.episodes[0].stage = 'ready';
  h.JE.internals.arrStatusDetails.render(h.document.getElementById('itemDetailPage'), s, {}); await turn();
  assert.equal(reads.length, initial + 3);
});

test('regression F5: view departure cancels action, probe, lost-item and settlement work', async t => {
  const h = fixture(t);
  await h.JE.internals.arrStatusDetails.update(false); await h.advance(500);
  const A = h.JE.internals.arrStatusArrival, state = A.state();
  for (const field of ['timer', 'probeTimer', 'lostTimer', 'settleTimer']) state[field] = h.window.setTimeout(() => assert.fail('departed arrival ran'), 1000);
  const ids = ['timer', 'probeTimer', 'lostTimer', 'settleTimer'].map(field => state[field]);
  state.view.dispatchEvent(new h.window.CustomEvent('viewbeforehide'));
  assert.equal(A.state(), null);
  assert.ok(ids.every(n => !h.timers.has(n)));
  await h.advance(1500);
});

test('regression F1: an arriving episode absent from the native list is inserted without replacing sibling links', async t => {
  const h = fixture(t);
  const page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const sibling = page.querySelector('.listItem');
  page.querySelectorAll('.listItem')[2].remove();
  const pending = h.status();pending.episodes[2].row = false;pending.episodes[2].itemId = null;
  D.render(page,pending,{});
  h.JE.helpers.getItemCached = async itemId => ({Id:itemId,Name:'<Episode three>',Overview:'Native episode overview'});
  const ready=h.status();ready.episodes[2].stage='ready';ready.episodes[2].reason.code='ready';
  D.render(page,ready,{});await turn();
  assert.equal(page.querySelectorAll('.listItem').length,6);
  assert.equal(page.querySelector('.listItem'),sibling);
  const row=page.querySelector(`.listItem[data-id="${id(3)}"]`);
  assert.equal(row.querySelector('.listItemBodyText').textContent,'3. <Episode three>');
  assert.equal(row.querySelector('episode'),null,'native metadata is escaped');
  assert.ok(row.querySelector('a[href]').getAttribute('href').includes(id(3)));
  let scans=0;const query=page.querySelectorAll.bind(page);page.querySelectorAll=selector=>{if(selector==='.listItem[data-id]')scans++;return query(selector);};
  await h.advance(100);assert.equal(scans,0,'our native arrival insertion does not cause a follow-up scan');
});

test('regression F1: a late native arrival read never writes into a departed season', async t => {
  const h=fixture(t),page=h.document.getElementById('itemDetailPage'),D=h.JE.internals.arrStatusDetails;
  page.querySelectorAll('.listItem')[2].remove();
  const pending=h.status();pending.episodes[2].row=false;pending.episodes[2].itemId=null;D.render(page,pending,{});
  const read=deferred();h.JE.helpers.getItemCached=()=>read.promise;
  const ready=h.status();ready.episodes[2].stage='ready';ready.episodes[2].reason.code='ready';D.render(page,ready,{});await turn();
  h.window.history.replaceState(null,'','#/home');read.resolve({Id:id(3),Name:'Departed'});await turn();
  assert.equal(page.querySelectorAll('.listItem').length,5);
});

test('regression F3: changed ring percentages update retained SVG without allocating a candidate overlay', async t => {
  const h=fixture(t,'episode'),host=h.document.querySelector('.cardImageContainer'),S=h.JE.arrStatus;
  const status=h.status();S.paintArtwork(host,status);
  const art=host.querySelector('.je-arr-art'),svg=host.querySelector('svg');h.reset();
  S.paintArtwork(host,{...status,progress:{percent:72}});
  assert.equal(host.querySelector('.je-arr-art'),art);assert.equal(host.querySelector('svg'),svg);
  assert.equal(art.dataset.jeArrArt,'pct:72');assert.equal(host.querySelector('.je-arr-art-text').textContent,'72%');
  assert.equal(h.counters.creates,0,'no candidate overlay is allocated then discarded');
});

test('regression F1: settlement reuses the last accepted answer while a newer status read is pending', async t => {
  const h=fixture(t),D=h.JE.internals.arrStatusDetails;
  await D.update(false);await h.advance(500);
  await h.change([`${base}:s1:e1`],'almostReady',1);await h.advance(100);
  const view=h.document.getElementById('itemDetailPage');
  view.addEventListener('viewshow',()=>view.querySelectorAll('[data-je-arr-surface="details"]').forEach(n=>n.remove()));
  const next=deferred();h.JE.core.api.plugin=path=>{h.calls.push(path);return next.promise;};
  const pending=D.update(true);await turn();
  await h.advance(8000);
  assert.ok(view.querySelector('.je-arr-status'),'the accepted answer survives the coalesced host redraw');
  assert.equal(view.querySelector('.je-arr-art').dataset.jeArrArt,'almost');
  next.resolve({items:[h.status()]});await pending;
});

test('regression F1: an authoritative empty answer cannot be repainted from the previous accepted status', async t => {
  const h=fixture(t),D=h.JE.internals.arrStatusDetails;
  await D.update(false);await h.advance(500);
  h.JE.internals.arrStatusArrival.vanished=async()=>false;
  h.JE.core.api.plugin=async()=>({items:[]});
  await D.update(true);assert.equal(h.document.querySelector('.je-arr-status'),null);
  D.repaint();assert.equal(h.document.querySelector('.je-arr-status'),null,'empty is authoritative during later reconciliation');
});

// F102: a season page open while an episode arrives shows the episode once. Jellyfin replaces a missing (virtual) episode
// with a playable item under another id, may draw both for a moment, and never tells the page the missing one went.
const nativeRow = (itemId, n, { missing = false, name = `Episode ${n}`, overview = `Virtual overview ${n}`, heart = false } = {}) =>
  `<div class="listItem listItem-largeImage" data-type="Episode" data-id="${itemId}" data-action="link"><div class="listItemImage" data-src="still-${itemId}.jpg"></div>`
  + `<div class="listItemBody itemAction"><div class="listItemBodyText"><bdi>${n}. ${name}</bdi></div><div class="secondary listItemMediaInfo listItemBodyText" style="display:none">`
  + `${missing ? '<div class="mediaInfoItem starRatingContainer">7.4</div><div class="missingIndicator">Missing</div>' : '<div class="mediaInfoItem">22m</div>'}</div>`
  + `<a class="itemAction" href="#/details?id=${itemId}">Open</a><div class="secondary listItem-overview listItemBodyText"><bdi>${overview}</bdi></div></div>`
  + `${heart ? `<button is="emby-ratingbutton" class="listItemButton itemAction" data-id="${itemId}">Favourite</button>` : ''}</div>`;
// Missing E(first) and E(first + 1), then four playable siblings; optionally the playable item of E(first) beside its missing one.
const seasonRows = (first, { physical = false } = {}) => [
  nativeRow(id(1), first, { missing: true }),
  ...(physical ? [nativeRow(id(501), first, { name: 'Playable one', overview: 'Physical overview', heart: true })] : []),
  nativeRow(id(2), first + 1, { missing: true }),
  ...[3, 4, 5, 6].map(k => nativeRow(id(k), first + k - 1, { overview: `Overview ${k}` })),
].join('');
function seasonStatus(h, first, ready = {}) {
  const s = h.status();
  s.episodes.forEach((ep, n) => { ep.episode = first + n; ep.key = `${base}:s${first ? 1 : 0}:e${first + n}`; });
  for (const [at, itemId] of Object.entries(ready)) Object.assign(s.episodes[at], { stage: 'ready', reason: { code: 'ready' }, itemId, progress: null });
  s.summary.ready = Object.keys(ready).length;
  return s;
}
const rowIds = page => [...page.querySelectorAll('.itemsContainer > .listItem')].map(row => row.getAttribute('data-id'));
const physicalOne = itemId => ({ Id: itemId, Name: 'Playable one', Overview: 'Physical overview', SeriesId: 'series', ImageTags: { Primary: 'still' } });

for (const first of [1, 0]) for (const redraw of [true, false]) test(`regression F102: season ${first ? 1 : 0}, ${redraw ? 'after the host redrew its list' : 'with the native row retained'}, the missing E${first} arriving under a new id leaves one row at its place with the playable item`, async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(first);
  h.window.ApiClient.getImageUrl = (itemId, o) => `img/${itemId}/${o.tag}`;
  D.render(page, seasonStatus(h, first), {});
  if (redraw) { list.innerHTML = seasonRows(first); await turn(); await h.advance(100); }
  const row = list.firstElementChild, link = row.querySelector('a[href]');
  h.JE.helpers.getItemCached = async itemId => physicalOne(itemId);
  D.render(page, seasonStatus(h, first, { 0: id(501) }), {}); await turn(); await h.advance(100);
  assert.deepEqual(rowIds(page), [id(501), id(2), id(3), id(4), id(5), id(6)], 'one E1 row, at its place, before E2');
  assert.equal(list.firstElementChild, row, 'the row under the viewer\'s finger stays');
  assert.equal(row.querySelector('a[href]'), link);
  assert.ok(link.getAttribute('href').includes(id(501)));
  assert.equal(row.querySelector('.missingIndicator, .je-arr-chip'), null);
  assert.equal(row.querySelector('.listItemBodyText bdi').textContent, `${first}. Playable one`);
  assert.equal(row.querySelector('.listItem-overview').textContent, 'Physical overview');
  assert.ok(row.querySelector('.listItemImage').style.backgroundImage.includes(`img/${id(501)}/still`));
  assert.ok(!page.textContent.includes(`Virtual overview ${first}`));
  assert.equal(page.querySelectorAll('.listItem .missingIndicator').length, 1, 'E2 is still missing');
  // The same answer again (and a later host mutation pass) changes nothing.
  D.render(page, seasonStatus(h, first, { 0: id(501) }), {}); await turn(); await h.advance(100);
  assert.deepEqual(rowIds(page), [id(501), id(2), id(3), id(4), id(5), id(6)]);
  assert.equal(list.firstElementChild, row);
});

for (const listed of ['still listed as missing', 'already gone']) test(`regression F102: a season drawn with E1's missing item beside its playable one (${listed}) shows E1 once; a special numbered 1 stays`, async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  // Jellyfin interleaves a missing special (season 0, E1) into the season's list.
  list.innerHTML = seasonRows(1, { physical: true }) + nativeRow(id(900), 1, { missing: true, name: 'A special', overview: 'Special overview' });
  const heart = list.querySelector(`[data-id="${id(501)}"] button`);
  const episodes = [];
  const item = (k, index, extra = {}) => ({ Id: id(k), IndexNumber: index, ParentIndexNumber: 1, SeasonId: id(100), LocationType: 'FileSystem', ...extra });
  const getUrl = h.window.ApiClient.getUrl;
  h.window.ApiClient.getUrl = (path, query) => getUrl(path) + (query ? '?' + new URLSearchParams(query) : '');
  h.window.ApiClient.getJSON = async url => {
    const u = new URL(url);
    episodes.push({ seriesId: u.pathname.split('/')[2], query: { seasonId: u.searchParams.get('seasonId') } });
    return { Items: [
      ...(listed === 'already gone' ? [] : [item(1, 1, { LocationType: 'Virtual' })]),
      item(501, 1), item(2, 2, { LocationType: 'Virtual' }), item(3, 3), item(4, 4), item(5, 5), item(6, 6),
      item(900, 1, { ParentIndexNumber: 0, SeasonId: id(899), LocationType: 'Virtual' }),
    ] };
  };
  h.JE.helpers.getItemCached = async itemId => (itemId === id(100) ? { Id: id(100), SeriesId: 'series' } : null);
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn(); await h.advance(100);
  assert.deepEqual(rowIds(page), [id(501), id(2), id(3), id(4), id(5), id(6), id(900)]);
  assert.equal(list.firstElementChild.querySelector('button'), heart, 'the native playable row keeps its controls');
  assert.deepEqual(episodes.map(e => [e.seriesId, e.query.seasonId]), [['series', id(100)]], 'one viewer list read');
  assert.ok(!page.textContent.includes('Virtual overview 1'));
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn(); await h.advance(100);
  assert.equal(episodes.length, 1, 'the season is listed once for the same rows');
  assert.deepEqual(rowIds(page), [id(501), id(2), id(3), id(4), id(5), id(6), id(900)]);
});

test('regression F102: a missing row Jellyfin no longer lists stays while an episode still waits for its row', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1, { physical: true });
  h.window.ApiClient.getJSON = async () => ({ Items: [501, 3, 4, 5, 6].map(k => ({ Id: id(k), IndexNumber: k === 501 ? 1 : k, SeasonId: id(100), LocationType: 'FileSystem' })) });
  h.JE.helpers.getItemCached = async itemId => (itemId === id(100) ? { Id: id(100), SeriesId: 'series' } : null);
  // E2's status names a missing item the page has no row for: an unknown missing row could be its.
  const status = seasonStatus(h, 1, { 0: id(501) }); status.episodes[1].itemId = id(702);
  D.render(page, status, {}); await turn(); await h.advance(100);
  assert.ok(rowIds(page).includes(id(1)), 'kept while E2 waits for its own row');
});

test('regression F102: a file covering E1–E2 replaces both missing rows with one row at E1', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  D.render(page, seasonStatus(h, 1), {});
  list.innerHTML = seasonRows(1); await turn(); await h.advance(100);
  h.JE.helpers.getItemCached = async itemId => physicalOne(itemId);
  D.render(page, seasonStatus(h, 1, { 0: id(501), 1: id(501) }), {}); await turn(); await h.advance(100);
  assert.deepEqual(rowIds(page), [id(501), id(3), id(4), id(5), id(6)]);
});

test('regression F102: through JE\'s one host redraw that draws the missing E1 beside its playable row, then a later arrival after it', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  const handlers = [];
  h.window.ApiClient.subscribe = (_types, fn) => { handlers.push(fn); return () => {}; };
  list.innerHTML = seasonRows(1);
  let current = seasonStatus(h, 1);
  h.JE.core.api.plugin = async path => { h.calls.push(path); return { items: [current] }; };
  let shows = 0;
  page.addEventListener('viewshow', () => { shows++; list.innerHTML = seasonRows(1, { physical: true }); });
  await D.update(false); await h.advance(500);
  assert.equal(handlers.length, 1);
  current = seasonStatus(h, 1, { 0: id(501) });
  await h.change([`${base}:s1:e1`]); await h.advance(20000);
  assert.equal(shows, 1);
  assert.deepEqual(rowIds(page), [id(501), id(2), id(3), id(4), id(5), id(6)]);
  assert.ok(list.firstElementChild.querySelector('button.listItemButton'), 'the native playable row and its controls');
  // After that one redraw Jellyfin names E2's missing item removed alone (no season): the status is read again and the
  // row stays while E2 is not playable yet.
  const reads = h.calls.length;
  handlers[0]({ MessageType: 'LibraryChanged', Data: { ItemsAdded: [], ItemsUpdated: [], ItemsRemoved: [id(2)] } });
  await h.advance(2000);
  assert.ok(h.calls.length > reads, 'the removal of a row\'s item reads the season again');
  assert.deepEqual(rowIds(page), [id(501), id(2), id(3), id(4), id(5), id(6)]);
  // E2 arrives (its metadata answer held back); the removal named with its season too, twice.
  const meta = deferred();
  h.JE.helpers.getItemCached = () => meta.promise;
  current = seasonStatus(h, 1, { 0: id(501), 1: id(502) });
  for (let n = 0; n < 2; n++) { handlers[0]({ MessageType: 'LibraryChanged', Data: { ItemsRemoved: [id(2)], FoldersRemovedFrom: [id(100)] } }); await h.advance(2000); }
  await h.change([`${base}:s1:e2`]); await h.advance(20000);
  assert.equal(shows, 1, 'no second host redraw');
  // Until the playable item's read answers, E2's row stays exactly as Jellyfin drew it.
  assert.deepEqual(rowIds(page), [id(501), id(2), id(3), id(4), id(5), id(6)]);
  const two = list.children[1];
  assert.ok(two.querySelector('.missingIndicator'));
  meta.resolve({ Id: id(502), Name: 'Playable two', Overview: 'Physical overview two', SeriesId: 'series' }); await turn();
  assert.deepEqual(rowIds(page), [id(501), id(502), id(3), id(4), id(5), id(6)]);
  assert.equal(list.children[1], two);
  assert.equal(two.querySelector('.missingIndicator'), null);
  assert.equal(two.querySelector('.listItemBodyText bdi').textContent, '2. Playable two');
  assert.equal(two.querySelector('.listItem-overview').textContent, 'Physical overview two');
  handlers[0]({ MessageType: 'LibraryChanged', Data: { ItemsRemoved: [id(2)] } }); await h.advance(2000);
  assert.deepEqual(rowIds(page), [id(501), id(502), id(3), id(4), id(5), id(6)]);
  assert.equal(list.children[1], two);
});

for (const leave of ['route', 'user']) test(`regression F102: a playable item's metadata read late never writes after a ${leave} change`, async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  D.render(page, seasonStatus(h, 1), {});
  const meta = deferred();
  h.JE.helpers.getItemCached = () => meta.promise;
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn();
  if (leave === 'route') h.window.history.replaceState(null, '', '#/home');
  else h.window.ApiClient.getCurrentUserId = () => 'user-b';
  meta.resolve(physicalOne(id(501))); await turn();
  assert.equal(list.firstElementChild.querySelector('.listItemBodyText bdi').textContent, '1. Episode 1');
  assert.equal(list.firstElementChild.querySelector('.listItem-overview').textContent, 'Virtual overview 1');
});

test('regression F102: a host redraw that brings back the replaced missing row is put right before the frame is painted', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  D.render(page, seasonStatus(h, 1), {});
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn();
  // Jellyfin's list as a 12.2 server drew it live: the playable item first, its missing twin after it.
  list.innerHTML = seasonRows(1, { physical: true }).replace(/(<div class="listItem[^>]*data-id="0+1"[\s\S]*?)(<div class="listItem[^>]*data-id="0+501"[\s\S]*?)(<div class="listItem[^>]*data-id="0+2")/, '$2$1$3');
  assert.equal(rowIds(page)[0], id(501), 'fixture: physical drawn first');
  await turn();
  assert.deepEqual(rowIds(page), [id(501), id(2), id(3), id(4), id(5), id(6)], 'in the mutation callback, no debounce or timer');
  assert.ok(list.firstElementChild.querySelector('button.listItemButton'));
});

test('regression F102: after the person\'s access revision moves, what the page learnt is read again from their own season list', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1, { physical: true });
  const reads = [];
  h.window.ApiClient.getJSON = async url => {
    reads.push(url);
    return { Items: [[1, 1, 'Virtual'], [501, 1, 'FileSystem'], [2, 2, 'Virtual'], [3, 3], [4, 4], [5, 5], [6, 6]].map(([k, n, type = 'FileSystem']) => ({ Id: id(k), IndexNumber: n, SeasonId: id(100), LocationType: type })) };
  };
  h.JE.helpers.getItemCached = async itemId => (itemId === id(100) ? { Id: id(100), SeriesId: 'series' } : null);
  D.render(page, seasonStatus(h, 1), {});
  const statusReads = [];
  h.JE.core.api.plugin = async path => { statusReads.push(path); return { items: [seasonStatus(h, 1, { 0: id(501) })] }; };
  h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision'));
  await turn(); await h.advance(100);
  assert.equal(statusReads.length, 1, 'the status is read again as they are now');
  assert.equal(reads.length, 1, 'the missing E1 row is looked up in the viewer\'s list, not taken from before');
  assert.deepEqual(rowIds(page), [id(501), id(2), id(3), id(4), id(5), id(6)]);
});

// F102 round 1 (SRD-1..3): a redraw while the playable item is read, the person's access moving, keyboard focus.
const listed = (...rows) => ({ Items: rows.map(([k, n, type = 'FileSystem']) => ({ Id: id(k), IndexNumber: n, SeasonId: id(100), LocationType: type })) });

test('regression SRD-1: Jellyfin redrawing the list while the playable item is read still gets its title, overview and still', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  h.window.ApiClient.getImageUrl = (itemId, o) => `img/${itemId}/${o.tag}`;
  D.render(page, seasonStatus(h, 1), {});
  const metadata = deferred(); let reads = 0;
  h.JE.helpers.getItemCached = () => { reads++; return metadata.promise; };
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn();
  const first = list.firstElementChild;
  assert.equal(first.dataset.id, id(1), 'nothing pointed before the item read answers');
  list.innerHTML = seasonRows(1); await turn(); await h.advance(100);
  assert.notEqual(list.firstElementChild, first, 'the host replaced the row');
  assert.equal(list.firstElementChild.dataset.id, id(1));
  assert.ok(list.firstElementChild.querySelector('.missingIndicator'));
  metadata.resolve(physicalOne(id(501))); await turn(); await h.advance(100);
  const row = list.firstElementChild;
  assert.equal(row.dataset.id, id(501));
  assert.equal(row.querySelector('.listItemBodyText bdi').textContent, '1. Playable one');
  assert.equal(row.querySelector('.listItem-overview').textContent, 'Physical overview');
  assert.ok(row.querySelector('.listItemImage').style.backgroundImage.includes(`img/${id(501)}/still`));
  // A later redraw is drawn from the same answer at once (no second read, no frame with the missing item's text).
  list.innerHTML = seasonRows(1); await turn();
  assert.equal(list.firstElementChild.querySelector('.listItemBodyText bdi').textContent, '1. Playable one');
  assert.equal(reads, 1);
  assert.equal(page.querySelectorAll('.listItem').length, 6);
});

test('regression SRD-2: a season-list answer read before the person\'s access moved is not used', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails, E = h.JE.internals.arrStatusEpisodes;
  page.querySelector('.itemsContainer').innerHTML = seasonRows(1, { physical: true });
  const answer = deferred(); let reads = 0;
  h.JE.helpers.getItemCached = async itemId => ({ Id: itemId, SeriesId: 'series' });
  h.window.ApiClient.getJSON = () => { reads++; return answer.promise; };
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn();
  assert.equal(reads, 1);
  // Their status read again under the new access no longer names a row for E1.
  const fresh = seasonStatus(h, 1); fresh.episodes[0].row = false; fresh.episodes[0].itemId = null;
  h.JE.core.api.plugin = async () => ({ items: [fresh] });
  h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision'));
  answer.resolve(listed([1, 1, 'Virtual'], [501, 1], [2, 2, 'Virtual'], [3, 3], [4, 4], [5, 5], [6, 6]));
  await turn(); await h.advance(100);
  assert.equal(E.removed([id(1)]), false, 'the old answer did not teach the page its missing E1 again');
  assert.ok(rowIds(page).includes(id(1)), 'nothing removed on the old answer');
});

test('regression SRD-2: losing access mid-arrival puts the row back to its missing item and never points it at the item again', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  D.render(page, seasonStatus(h, 1), {});
  h.JE.helpers.getItemCached = async itemId => physicalOne(itemId);
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn(); await h.advance(100);
  const row = list.firstElementChild;
  assert.equal(row.dataset.id, id(501));
  assert.equal(row.querySelector('.listItemBodyText bdi').textContent, '1. Playable one');
  // Their library access goes: the status read again names E1's missing item, not the playable one.
  const reads = [];
  h.JE.core.api.plugin = async path => { reads.push(path); return { items: [seasonStatus(h, 1)] }; };
  h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision'));
  assert.equal(row.dataset.id, id(1), 'back at once, before any answer');
  assert.ok(row.querySelector('.missingIndicator'));
  assert.equal(row.querySelector('.listItemBodyText bdi').textContent, '1. Episode 1');
  assert.equal(row.querySelector('.listItem-overview').textContent, 'Virtual overview 1');
  assert.ok(row.querySelector('a[href]').getAttribute('href').includes(id(1)));
  // Jellyfin redraws its list meanwhile: the old Ready status points nothing.
  list.innerHTML = seasonRows(1); await turn(); await h.advance(100);
  assert.equal(list.firstElementChild.dataset.id, id(1));
  assert.ok(list.firstElementChild.querySelector('.missingIndicator'));
  assert.equal(reads.length, 1, 'the status is read again as they are now');
  assert.ok(!page.textContent.includes('Playable one'));
});

test('regression SRD-2: an item Jellyfin refuses the viewer is never left as the row\'s target', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  D.render(page, seasonStatus(h, 1), {});
  let reads = 0;
  h.JE.helpers.getItemCached = async () => { reads++; throw Object.assign(new Error('HTTP 403'), { status: 403 }); };
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn(); await h.advance(100);
  const row = list.firstElementChild;
  assert.equal(row.dataset.id, id(1));
  assert.ok(row.querySelector('.missingIndicator'));
  assert.ok(row.querySelector('a[href]').getAttribute('href').includes(id(1)));
  list.innerHTML = seasonRows(1); await turn(); await h.advance(100);
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn(); await h.advance(100);
  assert.equal(list.firstElementChild.dataset.id, id(1), 'not pointed at it again');
  assert.equal(reads, 1);
});

test('regression SRD-3: focus on the missing row that goes moves to the same control of the row that stays, and is announced', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  D.render(page, seasonStatus(h, 1), {});
  const old = list.firstElementChild.querySelector('a[href]');
  old.focus(); assert.equal(h.document.activeElement, old);
  list.insertAdjacentHTML('beforeend', nativeRow(id(501), 1, { name: 'Playable one', heart: true }));
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {});
  const kept = list.querySelector(`[data-id="${id(501)}"]`);
  assert.equal(h.document.activeElement, kept.querySelector('a[href]'), 'the same kind of control, on the episode that stays');
  assert.ok(!old.isConnected);
  await h.advance(100);
  const live = h.document.querySelector('.je-arr-episodes-live');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.textContent, 'arr_episode_row_ready{"episode":1}');
});

test('regression SRD-3: focus on a missing row whose surviving row has only a button lands on that button', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  D.render(page, seasonStatus(h, 1), {});
  list.firstElementChild.querySelector('a[href]').focus();
  // The native playable row as jellyfin-web 12.2 draws it: image/body .itemAction divs (not focusable) and its buttons.
  list.insertAdjacentHTML('afterbegin', nativeRow(id(501), 1, { heart: true }).replace(/<a class="itemAction"[^>]*>Open<\/a>/, ''));
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {});
  assert.equal(h.document.activeElement, list.querySelector(`[data-id="${id(501)}"] button`));
});

test('regression F102 (R4): the same page shown for another season starts from nothing', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails, E = h.JE.internals.arrStatusEpisodes;
  const list = page.querySelector('.itemsContainer'); list.innerHTML = seasonRows(1); D.render(page, seasonStatus(h, 1), {});
  assert.equal(E.removed([id(1)]), true);
  h.window.history.replaceState(null, '', `#/details?id=${id(101)}`);
  const next = seasonStatus(h, 1); next.itemId = id(101); next.key = `${base}:s2`;
  next.episodes.forEach((ep, n) => { ep.itemId = id(1001 + n); });
  list.innerHTML = next.episodes.map((ep, n) => nativeRow(ep.itemId, n + 1, { missing: true })).join('');
  D.render(page, next, {});
  assert.equal(E.removed([id(1)]), false);
});

// F102 round 2 (SRD-R2-1..4): a row is pointed at its playable item as one transaction (the item read succeeds under
// the season owner, access revision and trusted status it started with); a failure or a change leaves it as drawn.
function withRevision(h, value = 'rev-a') {
  let access = value;
  h.JE.core.revision = { access: () => access };
  return next => { access = next; h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision', { detail: { revision: next } })); };
}
const assertMissing = (row, message) => {
  assert.equal(row.dataset.id, id(1), message);
  assert.ok(row.querySelector('.missingIndicator'), message);
  assert.equal(row.querySelector('.listItemBodyText bdi').textContent, '1. Episode 1', message);
  assert.ok(row.querySelector('a[href]').getAttribute('href').includes(id(1)), message);
  assert.equal(row.dataset.jeArrWas, undefined, message);
};

for (const failure of ['a 500', 'a timeout']) test(`regression SRD-R2-1: ${failure} on the playable item's read leaves the missing row exactly as drawn; the next status read tries once more`, async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  D.render(page, seasonStatus(h, 1), {});
  let reads = 0;
  h.JE.helpers.getItemCached = () => { reads++; return failure === 'a 500' ? Promise.reject(Object.assign(new Error('HTTP 500'), { status: 500 })) : new Promise(() => {}); };
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn(); await h.advance(10000);
  assertMissing(list.firstElementChild, 'nothing half-pointed');
  list.innerHTML = seasonRows(1); await turn(); await h.advance(100);
  assertMissing(list.firstElementChild, 'a redraw meanwhile starts nothing new');
  assert.equal(reads, 1);
  h.JE.helpers.getItemCached = async itemId => { reads++; return physicalOne(itemId); };
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn(); await h.advance(100);
  if (failure === 'a 500') {
    assert.equal(reads, 2, 'tried again with the next status read');
    assert.equal(list.firstElementChild.dataset.id, id(501));
    assert.equal(list.firstElementChild.querySelector('.listItemBodyText bdi').textContent, '1. Playable one');
  } else {
    assert.equal(reads, 1, 'the read still in flight is the one');
    assertMissing(list.firstElementChild, 'still waiting, still as drawn');
  }
});

test('regression SRD-R2-2: an item read from before the person\'s access moved neither points the row nor holds up the new read', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const move = withRevision(h);
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  D.render(page, seasonStatus(h, 1), { access: 'rev-a' });
  const old = deferred(); const reads = [];
  // Under the new access the page starts from nothing: the viewer's season list says which row is E1's missing item.
  h.window.ApiClient.getJSON = async () => listed([1, 1, 'Virtual'], [2, 2, 'Virtual'], [3, 3], [4, 4], [5, 5], [6, 6]);
  h.JE.helpers.getItemCached = itemId => {
    if (itemId === id(100)) return Promise.resolve({ Id: id(100), SeriesId: 'series' });
    if (itemId !== id(501)) return Promise.resolve(null);
    reads.push(itemId);
    return reads.length === 1 ? old.promise : Promise.resolve({ ...physicalOne(itemId), Name: 'Read under the new access' });
  };
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), { access: 'rev-a' }); await turn();
  assert.equal(reads.length, 1);
  h.JE.core.api.plugin = async () => ({ items: [seasonStatus(h, 1, { 0: id(501) })] });
  move('rev-b');
  // Their status read under the new access still names the playable E1.
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), { access: 'rev-b' }); await turn(); await h.advance(100);
  old.resolve(physicalOne(id(501))); await turn(); await h.advance(100);
  assert.equal(reads.length, 2, 'the new access reads the item itself');
  assert.equal(page.querySelectorAll('.listItem').length, 6, 'one E1 row');
  const row = list.firstElementChild;
  assert.equal(row.dataset.id, id(501));
  assert.equal(row.querySelector('.listItemBodyText bdi').textContent, '1. Read under the new access');
});

test('regression SRD-R2-3: a status read before the person\'s access moved, answering after it, points and removes nothing', async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails;
  const move = withRevision(h);
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1, { physical: true });
  const reads = [];
  h.JE.helpers.getItemCached = async itemId => { if (itemId === id(100)) return { Id: id(100), SeriesId: 'series' }; reads.push(itemId); return physicalOne(itemId); };
  h.window.ApiClient.getJSON = async () => { reads.push('list'); return listed([1, 1, 'Virtual'], [501, 1], [2, 2, 'Virtual'], [3, 3], [4, 4], [5, 5], [6, 6]); };
  D.render(page, seasonStatus(h, 1), { access: 'rev-a' });
  move('rev-b');
  // The status read in flight before the move answers now (Ready E1): it was read under the old access.
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), { access: 'rev-a' }); await turn(); await h.advance(100);
  assert.deepEqual(rowIds(page), [id(1), id(501), id(2), id(3), id(4), id(5), id(6)], 'nothing removed on its word');
  list.innerHTML = seasonRows(1); await turn(); await h.advance(100);
  assertMissing(list.firstElementChild, 'nothing pointed on its word');
  assert.deepEqual(reads, [], 'no item or list read on its word');
  // A read whose access moved while it was read is not trusted either.
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), { access: 'moved:rev-a' }); await turn(); await h.advance(100);
  assertMissing(list.firstElementChild, 'nor on a read the move overlapped');
  // The status read under the new access does.
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), { access: 'rev-b' }); await turn(); await h.advance(100);
  assert.equal(list.firstElementChild.dataset.id, id(501));
});

test('regression SRD-R2-3: the status read stamps the access it was read under, and a move during the read', async t => {
  const h = fixture(t);
  const move = withRevision(h);
  const held = deferred();
  h.JE.core.api.plugin = () => held.promise;
  const read = h.JE.arrStatus.fetchItem(id(100));
  await turn(); await h.advance(100);
  move('rev-b');
  held.resolve({ items: [h.status()] });
  const data = await read;
  assert.equal(data.access, 'moved:rev-a');
  h.JE.core.api.plugin = async () => ({ items: [h.status()] });
  assert.equal((await h.JE.arrStatus.fetchItem(id(100))).access, 'rev-b');
});

for (const visit of ['answer', 'refusal']) test(`regression SRD-R2-4: leaving the season drops what the visit learnt (its item ${visit}); the next visit reads again`, async t => {
  const h = fixture(t), page = h.document.getElementById('itemDetailPage'), D = h.JE.internals.arrStatusDetails, E = h.JE.internals.arrStatusEpisodes;
  const list = page.querySelector('.itemsContainer');
  list.innerHTML = seasonRows(1);
  await D.update(false); await h.advance(500);
  D.render(page, seasonStatus(h, 1), {});
  const reads = [];
  h.window.ApiClient.getJSON = async () => listed([1, 1, 'Virtual'], [2, 2, 'Virtual'], [3, 3], [4, 4], [5, 5], [6, 6]);
  h.JE.helpers.getItemCached = async itemId => {
    if (itemId === id(100)) return { Id: id(100), SeriesId: 'series' };
    reads.push(itemId);
    if (visit === 'refusal' && reads.length === 1) throw Object.assign(new Error('HTTP 404'), { status: 404 });
    return { ...physicalOne(itemId), Name: reads.length === 1 ? 'First visit name' : 'New visit name' };
  };
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn(); await h.advance(100);
  assert.equal(list.firstElementChild.dataset.id, visit === 'answer' ? id(501) : id(1));
  // Leaving for Home (the details navigation hook stops the page).
  h.window.history.replaceState(null, '', '#/home');
  h.nav.forEach(fn => fn()); await turn();
  D.stop();
  assert.equal(E.current(), null);
  assertMissing(list.firstElementChild, 'what JE did to the page goes with the visit');
  // Back on the season.
  h.window.history.replaceState(null, '', `#/details?id=${id(100)}`);
  D.render(page, seasonStatus(h, 1, { 0: id(501) }), {}); await turn(); await h.advance(100);
  assert.equal(reads.length, 2, 'the item is read again on the new visit');
  assert.equal(list.firstElementChild.dataset.id, id(501));
  assert.equal(list.firstElementChild.querySelector('.listItemBodyText bdi').textContent, '1. New visit name');
});
