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
  pill.focus(); pill.click(); h.reset();
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
  pill.click(); assert.ok(!journey.hidden, 'retained listener operates the retained journey');
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
  const answer = h.status(); answer.episodes[0].stage = 'ready'; answer.episodes[0].reason.code = 'ready'; answer.episodes[0].itemId = id(501);
  D.render(page, answer, {});
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
