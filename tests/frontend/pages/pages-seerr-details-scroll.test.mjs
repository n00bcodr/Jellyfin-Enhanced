import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';

// seamless-scroll.js: the failures, teardown and consumer contract pages-scroll.test.mjs leaves out.
function setup(t, { html = '<section id="feed"><div class="itemsContainer"></div></section>', helpers } = {}) {
  const observers = [];
  const h = createHarness({ html, globals: { IntersectionObserver: class { constructor(fn, options) { this.fn = fn; this.options = options; observers.push(this); } observe(target) { this.target = target; } disconnect() { this.disconnected = true; } } } });
  t.after(() => h.close());
  if (helpers) h.JE.helpers = helpers;
  h.load('jellyseerr/seamless-scroll.js');
  const section = h.document.querySelector('section');
  section.getClientRects = () => [{}];
  const state = {};
  t.after(() => h.JE.seamlessScroll.cleanupInfiniteScroll(state));
  // Backoff waits are immediate unless a test holds them.
  const backoffs = [];
  const realSet = h.window.setTimeout;
  h.window.setTimeout = (fn, ms) => { if (ms >= 500) { backoffs.push(fn); return 1000 + backoffs.length; } return realSet(fn, ms); };
  const clear = [];
  const realClear = h.window.clearTimeout;
  h.window.clearTimeout = id => { clear.push(id); realClear(id); };
  return { ...h, P: h.JE.seamlessScroll, state, section, observers, backoffs, cleared: clear,
    async settle() { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); },
    async release() { for (const fn of this.backoffs.splice(0)) fn(); await this.settle(); } };
}

test('a load that fails after teardown leaves no retry row and no unhandled failure', async t => {
  const h = setup(t);
  h.window.console.warn = () => {};
  const pending = deferred();
  let loads = 0;
  h.P.setupInfiniteScroll(h.state, '#feed', () => (++loads < 3 ? Promise.reject(new Error('offline')) : pending.promise), () => true, () => false);
  await h.settle();
  await h.release();
  await h.release();
  assert.equal(loads, 3);
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  h.P.cleanupInfiniteScroll(h.state);
  pending.reject(new Error('offline'));
  await h.settle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.document.querySelector('.je-retry-row'), null);
  assert.deepEqual(unhandled, []);
});

test('teardown cancels a waiting retry, so nothing loads afterwards', async t => {
  const h = setup(t);
  h.window.console.warn = () => {};
  let loads = 0;
  h.P.setupInfiniteScroll(h.state, '#feed', () => { loads++; return Promise.reject(new Error('offline')); }, () => true, () => false);
  await h.settle();
  assert.equal(h.backoffs.length, 1);
  h.P.cleanupInfiniteScroll(h.state);
  await h.settle();
  assert.ok(h.cleared.includes(1001), 'the backoff timer is cleared');
  await h.release();
  assert.equal(loads, 1);
});

test('three failures show the retry button, which resumes the same feed', async t => {
  const h = setup(t);
  h.window.console.warn = () => {};
  let loads = 0, failing = true;
  h.P.setupInfiniteScroll(h.state, '#feed', async () => { loads++; if (failing) throw new Error('offline'); return { pages: 0, rendered: 0 }; }, () => true, () => false);
  await h.settle();
  await h.release();
  await h.release();
  assert.equal(loads, h.P.CONFIG.retry.maxAttempts);
  const button = h.document.querySelector('.je-retry-row button');
  assert.equal(button.textContent, 'Try again');
  assert.equal(h.document.querySelector('.je-retry-row > span').textContent, 'Seerr did not answer.');
  failing = false;
  button.click();
  await h.settle();
  assert.equal(loads, h.P.CONFIG.retry.maxAttempts + 1);
  assert.equal(h.document.querySelector('.je-retry-row'), null);
});

test('an abort is not a failure', async t => {
  const h = setup(t);
  let loads = 0;
  h.P.setupInfiniteScroll(h.state, '#feed', async () => { loads++; throw Object.assign(new Error('x'), { name: 'AbortError' }); }, () => true, () => false);
  await h.settle();
  assert.equal(loads, 1);
  assert.equal(h.backoffs.length, 0);
  assert.equal(h.document.querySelector('.je-retry-row'), null);
});

test('a modal over the page holds the fill until it closes, and only its fill resumes', async t => {
  const h = setup(t);
  const cover = h.document.createElement('div');
  cover.className = 'je-more-info-modal';
  h.document.body.appendChild(cover);
  let loads = 0;
  h.P.setupInfiniteScroll(h.state, '#feed', async () => { loads++; return { pages: 0, rendered: 0 }; }, () => true, () => false);
  await h.settle();
  assert.equal(loads, 0);
  cover.remove();
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-more-info-closed'));
  await h.settle();
  assert.equal(loads, 1);
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-more-info-closed'));
  await h.settle();
  assert.equal(loads, 1, 'nothing was suspended this time');
});

test('a sentinel removed without cleanup stops the engine on the next scroll', async t => {
  const h = setup(t);
  let loads = 0;
  h.P.setupInfiniteScroll(h.state, '#feed', async () => { loads++; return { pages: 0, rendered: 0 }; }, () => true, () => false);
  await h.settle();
  const fill = h.state.fill;
  h.document.querySelector('.je-scroll-sentinel').remove();
  await new Promise(resolve => setTimeout(resolve, 110));
  h.window.dispatchEvent(new h.window.Event('scroll'));
  await h.settle();
  assert.equal(h.state.fill, null);
  assert.equal(h.observers[0].disconnected, true);
  await fill();
  assert.equal(loads, 1);
});

test('a second engine on the same state replaces the first, whose teardown cannot touch it', async t => {
  const h = setup(t);
  const load = async () => ({ pages: 0, rendered: 0 });
  h.P.setupInfiniteScroll(h.state, '#feed', load, () => true, () => false);
  const firstTeardown = h.state._teardown;
  h.P.setupInfiniteScroll(h.state, '#feed', load, () => true, () => false);
  assert.equal(h.observers[0].disconnected, true);
  firstTeardown();
  assert.equal(h.state.activeScrollObserver, h.observers[1]);
  assert.equal(h.observers[1].disconnected, undefined);
  assert.equal(h.document.querySelectorAll('.je-scroll-sentinel').length, 1);
  assert.equal(typeof h.state.fill, 'function');
});

test('a section that is not on the page sets nothing up', t => {
  const h = setup(t);
  h.P.setupInfiniteScroll(h.state, '#missing', async () => {}, () => true, () => false);
  assert.equal(h.observers.length, 0);
  assert.equal(h.state.fill, null);
});

test('a horizontal row sits idle until the viewer engages it, and a press on a card does not count', async t => {
  const h = setup(t, { html: '<section id="row"><div class="emby-scroller"><div class="itemsContainer"><div class="card"></div></div></div></section>' });
  const hints = [];
  const card = h.document.querySelector('.card');
  card.getBoundingClientRect = () => ({ right: 100, left: 0, top: 0, bottom: 10, width: 100, height: 10 });
  h.document.querySelector('.emby-scroller').getBoundingClientRect = () => ({ right: 1000, left: 0, top: 0, bottom: 10, width: 1000, height: 10 });
  h.section.getBoundingClientRect = () => ({ right: 1000, left: 0, top: 0, bottom: 10, width: 1000, height: 10 });
  h.P.setupInfiniteScroll(h.state, '#row', async hint => { hints.push(hint); return { pages: 0, rendered: 0 }; }, () => true, () => false, { horizontal: true });
  await h.settle();
  assert.equal(plain(hints)[0].engaged, false);
  assert.equal(h.observers[0].target, h.section);
  card.dispatchEvent(new h.window.Event('pointerdown', { bubbles: true }));
  await h.settle();
  assert.equal(hints.length, 1);
  h.document.querySelector('.emby-scroller').dispatchEvent(new h.window.Event('wheel', { bubbles: true }));
  await h.settle();
  assert.equal(hints.at(-1).engaged, true);
  assert.ok(hints.at(-1).deficitPx > hints[0].deficitPx);
});

test('the deduplicator keeps the first of each title, by media type and id or a custom key', t => {
  const h = setup(t);
  const dedupe = h.P.createDeduplicator();
  const items = [{ mediaType: 'movie', id: 1 }, { mediaType: 'tv', id: 1 }, { mediaType: 'movie', id: 1 }];
  assert.equal(dedupe.filter(items).length, 2);
  assert.equal(dedupe.size, 2);
  assert.equal(dedupe.add({ mediaType: 'movie', id: 1 }), false);
  assert.equal(dedupe.add({ key: 'a' }, item => item.key), true);
  dedupe.clear();
  assert.equal(dedupe.size, 0);
});

test('cardsNeeded plans from what is on screen, and falls back without it', t => {
  const h = setup(t, { html: '<section id="grid"><div class="c"></div></section>' });
  const container = h.document.querySelector('.c');
  assert.equal(h.P.cardsNeeded(null, { deficitPx: 100 }), 40);
  assert.equal(h.P.cardsNeeded(container, { deficitPx: 0 }, 20), 20);
  assert.equal(h.P.cardsNeeded(container, { deficitPx: 100 }, 20), 20);
  for (let i = 0; i < 4; i++) {
    const card = h.document.createElement('div');
    card.className = 'card';
    Object.defineProperty(card, 'offsetParent', { value: container });
    card.getBoundingClientRect = () => ({ width: 100, height: 200, top: i < 3 ? 0 : 200 });
    container.appendChild(card);
  }
  assert.equal(h.P.cardsNeeded(container, { deficitPx: 1000, horizontal: true }), 12);
  assert.equal(h.P.cardsNeeded(container, { deficitPx: 1000 }), 18);
  assert.equal(h.P.cardsNeeded(container, { deficitPx: 10, spanPx: 1000 }), 15, 'never less than most of a screen');
});

test('the facade keeps its names, and tuning CONFIG takes effect', async t => {
  const h = setup(t);
  for (const name of ['createDeduplicator', 'cardsNeeded', 'setupInfiniteScroll', 'cleanupInfiniteScroll']) assert.equal(typeof h.P[name], 'function', name);
  h.P.CONFIG.minBufferPx = 1;
  h.P.CONFIG.bufferViewports = 0;
  h.document.querySelector('section').appendChild(h.document.createElement('div'));
  h.window.innerHeight = 0;
  let loads = 0;
  h.P.setupInfiniteScroll(h.state, '#feed', async () => { loads++; return { pages: 0, rendered: 0 }; }, () => true, () => false);
  await h.settle();
  assert.equal(h.observers[0].options.rootMargin, '1px');
  assert.equal(loads, 1);
});

test('it can load before the rest of Jellyfin Enhanced', t => {
  const h = createHarness();
  t.after(() => h.close());
  delete h.window.JellyfinEnhanced;
  h.load('jellyseerr/seamless-scroll.js');
  assert.equal(typeof h.window.JellyfinEnhanced.seamlessScroll.setupInfiniteScroll, 'function');
});
