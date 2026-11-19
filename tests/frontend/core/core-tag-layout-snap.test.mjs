import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Whole pixels: Chromium painted the seven contained group containers from
// a whole pixel. They are no longer contained, so the layout controller
// moves each by the fraction of a pixel it is off (--je-snap-x and
// --je-snap-y, a pair of margins that cancel). These tests pin when a card
// is measured, what is written, and where nothing is.

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const card = `<div class="card overflowPortraitCard" data-id="${ID}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer coveredImage cardContent"></div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardText">Title</div></div></div>`;

const entry = () => ({
  Type: 'Movie', TmdbId: '42', Genres: ['Drama'], CommunityRating: 8.12, CriticRating: 91, OfficialRating: 'PG-13', AudioLanguages: ['en'],
  StreamData: { Streams: [{ Type: 'Video', Codec: 'hevc', Height: 2160, DisplayTitle: '4K HEVC' }], Sources: [{ Path: 'Movie (2020).mkv', Name: 'Movie (2020)' }], ItemName: 'Movie', ItemPath: 'Movie (2020).mkv' },
});

/** Where the card's image box is on the page, and where each group's container is within it (CSS px: x, y, width, height). */
const ROOT = [100.3, 50.7];
const HOST = [200.4, 300.6];
const BOXES = {
  quality: [6, 6, 60.5, 20],
  genre: [154.15, 6, 40.25, 40],
  rating: [154.15, 250.35, 40.25, 44.25],
  ageRating: [166.4, 226.1, 28, 20.25],
  status: [120.7, 50, 73.7, 24.9],
  custom: [6.3, 30.3, 50, 20],
};

/** The nudge of a coordinate: to the whole pixel of a grid of `scale` pixels per CSS pixel, in 64ths, a half going up. */
function nudge(value, scale = 1) {
  const units = Math.round(value * scale * 64);
  return (Math.floor(units / 64 + 0.5) * 64 - units) / 64 / scale;
}
const px = value => (value ? `${value}px` : '');

/** Timers by hand: `due(ms)` runs the pending ones of that delay. */
function handTimers() {
  const timers = [];
  return {
    globals: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; } },
    pending: ms => timers.filter(x => x.fn && x.ms === ms).length,
    due(ms) { for (const timer of timers.filter(x => x.fn && x.ms === ms)) { const fn = timer.fn; timer.fn = null; fn(); } },
  };
}

/**
 * The real renderers and layout controller over one card, in a browser of Chromium's family (or `vendor`'s)
 * whose layout is the table above: a container sits where the table says plus the nudge it carries, as margins
 * that cancel move it.
 */
function setup(t, { settings = {}, vendor = 'Google Inc.', ratio = 1, boxes = BOXES, globals = {} } = {}) {
  const renderers = new Map();
  const frames = [];
  /** Every size observer made: its callback and what it watches. */
  const observers = [];
  class Observer {
    constructor(report) { this.report = report; this.targets = new Map(); observers.push(this); }
    observe(target, options) { this.targets.set(target, options || {}); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  function Entry() {}
  Entry.prototype.devicePixelContentBoxSize = null;
  const h = createHarness({
    html: card,
    globals: {
      CSS: { supports: () => true }, requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
      requestIdleCallback: fn => { frames.push(() => fn({ timeRemaining: () => 50, didTimeout: false })); return frames.length; },
      ResizeObserver: Observer, ResizeObserverEntry: Entry, devicePixelRatio: ratio,
      ...globals,
    },
    JE: {
      currentSettings: { qualityTagsEnabled: true, genreTagsEnabled: true, ratingTagsEnabled: true, ageRatingTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', ...settings },
      pluginConfig: { TagCacheServerMode: true },
      t: key => key,
      cdn: { flagSvg: code => `http://jellyfin.test/flags/${code}.svg` },
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: {
        registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name), clearProcessed() {}, scheduleScan() {},
        peekReviewRatings: () => null, getReviewRatingsRequestedAt: () => 1, getReviewRatings: async () => null, onReviewRatingsChanged() {},
      },
    },
  });
  t.after(() => h.close());
  Object.defineProperty(h.window.navigator, 'vendor', { configurable: true, value: vendor });
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js',
    'tags/rating-sources.js', 'tags/qualitytags.js', 'tags/genretags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js']) h.load(file);
  const JE = h.JE;
  JE.initializeQualityTags(); JE.initializeGenreTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags();
  const host = h.document.querySelector('.je-tag-host');
  const root = h.document.querySelector('.cardScalable');

  // The layout: the image box at ROOT, the host over it, each container where the table says plus its nudge.
  const state = { boxes: { ...boxes }, host: HOST.slice(), zoom: 1, reads: 0 };
  const rect = (x, y, w, hh) => ({ x, y, left: x, top: y, right: x + w, bottom: y + hh, width: w, height: hh });
  const carried = (el, name) => parseFloat(el.style.getPropertyValue(name)) || 0;
  h.window.Element.prototype.getBoundingClientRect = function () {
    state.reads++;
    const z = state.zoom;
    if (this === root || this === host) return rect(ROOT[0], ROOT[1], state.host[0] * z, state.host[1] * z);
    // A slot: inset 6px, or the edges `slotBox` gives (a band runs from edge to edge and has the 6px as padding).
    const [slotLeft, slotRight] = state.slotBox || [6, state.host[0] - 6];
    if (this.classList.contains('je-tag-slot')) return rect(ROOT[0] + slotLeft * z, ROOT[1] + 6 * z, (slotRight - slotLeft) * z, (state.host[1] - 12) * z);
    const group = this.closest('[data-je-group]');
    // (`flowBoxes`: where a container sits once the card rests in flow, when that is not quite where it sat positioned.)
    const resting = host.dataset.jeFlow === '1' && !host.dataset.jeLive;
    const box = group && group.parentElement?.classList.contains('je-tag-slot') ? (resting && state.flowBoxes?.[group.dataset.jeGroup]) || state.boxes[group.dataset.jeGroup] : null;
    if (!box) return rect(0, 0, 0, 0);
    // (`xOf`: a layout where the horizontal margins do not simply move the container, as in Bands' top band.)
    const across = state.xOf ? state.xOf(group) : null;
    const x = ROOT[0] + (across ?? box[0] + carried(group, '--je-snap-x')) * z, y = ROOT[1] + (box[1] + carried(group, '--je-snap-y')) * z;
    return group === this ? rect(x, y, box[2] * z, box[3] * z) : rect(x, y, 4, 4);
  };
  Object.defineProperty(h.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('je-tag-host') ? state.host[0] : 0; } });
  Object.defineProperty(h.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return this.classList.contains('je-tag-host') ? state.host[1] : 0; } });
  // The layout's own size, to the pixel: a scale does not change it.
  Object.defineProperty(h.window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.classList.contains('je-tag-host') ? Math.round(state.host[0]) : 0; } });
  Object.defineProperty(h.window.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('je-tag-host') ? Math.round(state.host[1]) : 0; } });
  Object.defineProperty(h.window.HTMLImageElement.prototype, 'complete', { configurable: true, get() { return true; } });
  // Jellyfin's image box has layout and style containment: the pixel grid of what is inside starts at its corner.
  const styles = h.window.getComputedStyle;
  // (`styled.of`: what the page's CSS gives other elements, by element.)
  const styled = { reads: 0, of: new Map([[root, { contain: 'layout style' }]]) };
  h.window.getComputedStyle = function (el, ...rest) {
    styled.reads++;
    const style = styles.call(this, el, ...rest);
    const given = styled.of.get(el);
    if (!given) return style;
    return new Proxy(style, { get: (target, key) => (key in given ? given[key] : typeof target[key] === 'function' ? target[key].bind(target) : target[key]) });
  };

  /** Run the frames queued so far, and the ones they queue (the after-paint and idle passes). */
  const settle = () => { for (let i = 0; i < 20 && frames.length; i++) for (const fn of frames.splice(0)) fn(); };
  const watching = el => observers.filter(o => o.targets.has(el));
  /** The browser saying which grid it snaps to: the root's width in CSS and in device pixels. */
  const grid = (scale = ratio) => {
    const rootEl = h.document.documentElement;
    for (const o of watching(rootEl)) if (o.targets.get(rootEl).box === 'device-pixel-content-box') o.report([{ target: rootEl, contentBoxSize: [{ inlineSize: 1600 }], devicePixelContentBoxSize: [{ inlineSize: Math.round(1600 * scale) }] }]);
  };
  /** The browser reporting an element's size to whoever watches it. */
  const sized = (el, width, height) => { for (const o of watching(el)) if (o.targets.get(el).box !== 'device-pixel-content-box') o.report([{ target: el, borderBoxSize: [{ inlineSize: width, blockSize: height }], contentRect: { width, height } }]); };
  const group = name => host.querySelector(`.je-tag-slot > [data-je-group="${name}"]`);
  const snap = name => [group(name).style.getPropertyValue('--je-snap-x'), group(name).style.getPropertyValue('--je-snap-y')];
  /** How far each contained container's corner is from a whole pixel of the image box's grid, as the page now lies. */
  const offGrid = (scale = 1) => [...host.querySelectorAll('.je-tag-slot > [data-je-group]')].filter(el => el.dataset.jeGroup !== 'custom').map(el => el.getBoundingClientRect()).filter(r => r.width > 0)
    .map(r => Math.max(...[r.left - ROOT[0], r.top - ROOT[1]].map(v => Math.abs(v * scale - Math.round(v * scale))))).filter(off => off > 1 / 128);
  return Object.assign(h, {
    layout: JE.core.tagLayout, host, root, renderers, state, styled, settle, grid, sized, watching, observers, group, snap, offGrid,
    render() { for (const [, r] of renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(host, entry(), ID); },
    /** Draw the card and let the browser say its grid, then run the passes. */
    show() { this.render(); grid(); settle(); },
    add(name, cls = `${name}-overlay-container`, chip = 'chip') { const el = h.document.createElement('div'); el.className = cls; el.innerHTML = `<div class="${chip}">x</div>`; JE.core.tagLayout.commitGroup(host, name, el); return el; },
    async apply(changes) { Object.assign(JE.currentSettings, changes); await JE.reinitializeTagLayout(); },
  });
}

test('each contained group is moved to the whole pixel it was painted from, in one pass once the page is at rest', t => {
  const h = setup(t);
  h.render();
  assert.deepEqual(h.snap('rating'), ['', ''], 'nothing while the card is being drawn');
  assert.equal(h.state.reads, 0, 'and no layout read');
  assert.equal(h.offGrid().length, 3, 'three of the four containers lie between pixels');
  h.grid();
  h.settle();
  // From the image box's corner: the quality container is on whole pixels already; the others are off by a fraction.
  assert.deepEqual(h.snap('quality'), ['', '']);
  assert.deepEqual(h.snap('genre'), [px(nudge(154.15)), '']);
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15)), px(nudge(250.35))]);
  assert.deepEqual(h.snap('ageRating'), [px(nudge(166.4)), px(nudge(226.1))]);
  assert.equal(nudge(154.15), -0.15625, 'ten 64ths back');
  assert.equal(nudge(226.1), -0.09375);
  assert.deepEqual(h.offGrid(), [], 'every one of them now lies on whole pixels');
});

test('a card that goes to rest in flow is measured again as it then stands', t => {
  const h = setup(t);
  // The two layouts agree to within what the comparison allows, which is more than a layout unit.
  h.state.flowBoxes = { rating: [154.15, 250.36, 40.25, 44.25] };
  h.render();
  h.grid();
  assert.equal(h.host.dataset.jeFlow, undefined);
  h.settle();
  assert.equal(h.host.dataset.jeFlow, '1');
  assert.notEqual(nudge(250.36), nudge(250.35));
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15)), px(nudge(250.36))], 'the nudge is the resting layout\'s');
});

test('a card that leaves flow for a moment (a status tag back on its live filter under the pointer) is not measured for it', t => {
  const h = setup(t);
  h.show();
  h.add('status', 'status-overlay-container', 'status-tag');
  h.settle();
  assert.equal(h.host.dataset.jeFlow, '1');
  const passes = h.layout.snapStats().passes;
  h.state.reads = 0;
  // The painter hands the tag back to the live filter (tags/status-tag-backdrop.js use): the card is positioned meanwhile.
  h.host.dataset.jeBlur = '1';
  h.layout.syncFlowOf(h.host);
  assert.equal(h.host.dataset.jeFlow, undefined);
  h.settle();
  delete h.host.dataset.jeBlur;
  h.layout.syncFlowOf(h.host);
  h.settle();
  assert.equal(h.host.dataset.jeFlow, '1');
  assert.equal(h.layout.snapStats().passes, passes, 'no pass');
  assert.equal(h.state.reads, 0, 'and no layout read');
});

test('a half goes up, as the browser rounds it', t => {
  const h = setup(t, { boxes: { ...BOXES, rating: [100.5, 200.5, 40, 40], genre: [150.484375, 6, 40, 40] } });
  h.show();
  assert.deepEqual(h.snap('rating'), ['0.5px', '0.5px']);
  assert.deepEqual(h.snap('genre'), [px(-31 / 64), ''], 'a 64th under the half goes down');
});

test('a card measured again with nothing changed is written nothing: the nudge it has is taken out of what is read', t => {
  const h = setup(t);
  h.show();
  const moved = h.layout.snapStats().moved;
  assert.ok(moved > 0);
  h.layout.refreshPresentation([h.host]);
  h.settle();
  // (Presented again: new containers, the same nudges.)
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15)), px(nudge(250.35))]);
  const again = h.layout.snapStats().moved;
  // The same containers measured once more, where they now stand.
  h.layout.removeGroup(h.host, 'custom');
  h.add('custom');
  h.settle();
  assert.equal(h.layout.snapStats().moved, again, 'nothing written for a container that is where it should be');
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15)), px(nudge(250.35))]);
});

test('only the seven groups that were contained are moved', t => {
  const h = setup(t);
  h.render();
  h.add('custom', 'custom-overlay-container');
  h.add('status');
  h.grid();
  h.settle();
  assert.deepEqual(h.snap('custom'), ['', ''], 'a custom tag container never was: it stays between pixels');
  assert.deepEqual(h.snap('status'), [px(nudge(120.7)), '']);
});

test('the grid is the one the browser lays out in: device pixels, or CSS pixels under an emulated ratio', t => {
  const real = setup(t, { ratio: 2 });
  real.show();
  assert.equal(real.layout.snapStats().scale, 2);
  assert.deepEqual(real.snap('rating'), [px(nudge(154.15, 2)), px(nudge(250.35, 2))]);
  assert.equal(nudge(154.15, 2), -0.1484375, 'to the half pixel below: nineteen 128ths');
  // Device mode in the developer tools: the ratio says 2, the root is as many device pixels wide as CSS pixels.
  const emulated = setup(t, { ratio: 2 });
  emulated.render();
  emulated.grid(1);
  emulated.settle();
  assert.equal(emulated.layout.snapStats().scale, 1);
  assert.deepEqual(emulated.snap('rating'), [px(nudge(154.15)), px(nudge(250.35))]);
  // A fractional ratio (a 150% display): the value written reads back as the exact number of layout units.
  const dense = setup(t, { ratio: 1.5 });
  dense.show();
  const [x] = dense.snap('rating');
  assert.equal(Math.round(parseFloat(x) * 1.5 * 64 * 1e6) / 1e6, Math.round(nudge(154.15, 1.5) * 1.5 * 64));
});

test('nothing is measured until the browser has said which grid it snaps to; another grid measures every card again', t => {
  const h = setup(t);
  h.render();
  h.settle();
  assert.deepEqual(h.snap('rating'), ['', '']);
  assert.equal(h.layout.snapStats().waiting, 1, 'the card waits');
  h.grid();
  h.settle();
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15)), px(nudge(250.35))]);
  // Browser zoom, or the window on another screen.
  h.grid(2);
  h.settle();
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15, 2)), px(nudge(250.35, 2))]);
});

test('while the browser has not said which grid it snaps to, the cards wait and no idle period is asked for on their account', t => {
  const idles = [];
  const h = setup(t, { globals: { requestIdleCallback: fn => { idles.push(fn); return idles.length; } } });
  h.render();
  // The idle pass decides the card's resting layout; the card cannot be measured yet, and the pass does not keep
  // coming back for it.
  let ran = 0;
  for (; ran < 20 && idles.length; ran++) { idles.shift()({ timeRemaining: () => 50, didTimeout: false }); h.settle(); }
  assert.ok(ran < 6, `the pass came to an end (${ran} idle periods)`);
  assert.equal(h.host.dataset.jeFlow, '1');
  assert.equal(h.layout.snapStats().waiting, 1, 'the card waits to be measured');
  assert.deepEqual(h.snap('rating'), ['', '']);
  // The browser says: the pass is asked for, and measures it.
  h.grid();
  assert.equal(idles.length, 1);
  for (let i = 0; i < 6 && idles.length; i++) { idles.shift()({ timeRemaining: () => 50, didTimeout: false }); h.settle(); }
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15)), px(nudge(250.35))]);
  assert.equal(h.layout.snapStats().waiting, 0);
  assert.equal(idles.length, 0);
});

test('Firefox and WebKit paint a contained box where they paint a plain one: nothing is nudged, measured or watched there', t => {
  for (const vendor of ['', 'Apple Computer, Inc.']) {
    const h = setup(t, { vendor });
    h.show();
    for (const name of ['quality', 'genre', 'rating', 'ageRating']) assert.deepEqual(h.snap(name), ['', ''], `${vendor || 'Firefox'}: ${name}`);
    assert.equal(h.watching(h.document.documentElement).length, 0);
    assert.equal(h.watching(h.group('rating')).length, 0);
    assert.equal(h.layout.snapStats().passes, 0);
  }
});

test('a card is measured again when its size changes, once the size has held; its containers are not watched one by one', t => {
  const timers = handTimers();
  const h = setup(t, { globals: timers.globals });
  h.show();
  assert.equal(h.watching(h.host).length, 1, 'the host is watched, by the observer that refits cards');
  for (const name of ['quality', 'genre', 'rating', 'ageRating']) assert.equal(h.watching(h.group(name)).length, 0, `${name}: a watch on every container would be checked on every frame`);
  const passes = h.layout.snapStats().passes;
  // The first report is the size the pass measured at.
  h.sized(h.host, HOST[0], HOST[1]);
  h.settle();
  assert.equal(timers.pending(120), 0);
  assert.equal(h.layout.snapStats().passes, passes, 'the size it was measured at: nothing to do');
  // The card is a little wider: its right-aligned containers have other corners.
  h.state.host = [203.7, HOST[1]];
  h.state.boxes.rating = [157.45, 250.35, 40.25, 44.25];
  h.sized(h.host, 203.7, HOST[1]);
  h.settle();
  assert.equal(h.layout.snapStats().passes, passes, 'not on the frame that reports it');
  assert.equal(timers.pending(120), 1);
  h.sized(h.host, 203.7, HOST[1]);
  assert.equal(timers.pending(120), 1, 'one wait, for the size to hold');
  timers.due(120);
  h.settle();
  assert.deepEqual(h.snap('rating'), [px(nudge(157.45)), px(nudge(250.35))]);
  assert.equal(h.layout.snapStats().passes, passes + 1);
});

test('an image that loads in a tag, or a font that arrives, gives containers other sizes: the card is measured again', t => {
  const timers = handTimers();
  let fontsLoaded = null;
  const h = setup(t, { globals: timers.globals });
  h.document.fonts = { addEventListener: (type, fn) => { if (type === 'loadingdone') fontsLoaded = fn; } };
  // A logo chip whose image has not arrived yet.
  let complete = false;
  Object.defineProperty(h.window.HTMLImageElement.prototype, 'complete', { configurable: true, get() { return complete; } });
  h.state.boxes.logos = [6, 100.4, 20, 20];
  h.render();
  const logos = h.document.createElement('div');
  logos.className = 'logo-overlay-container';
  logos.innerHTML = '<span class="je-logo-chip"><img alt="" src="http://jellyfin.test/logo.png"></span>';
  h.layout.commitGroup(h.host, 'logos', logos);
  h.grid();
  h.settle();
  assert.deepEqual(h.snap('logos'), ['', px(nudge(100.4))]);
  const passes = h.layout.snapStats().passes;
  // It arrives: the chip is taller, and the stack it stands in starts higher.
  complete = true;
  h.state.boxes.logos = [6, 92.7, 20, 27.7];
  h.group('logos').querySelector('img').dispatchEvent(new h.window.Event('load'));
  timers.due(120);
  h.settle();
  assert.deepEqual(h.snap('logos'), ['', px(nudge(92.7))]);
  assert.ok(h.layout.snapStats().passes > passes, 'measured again (and once more as the card goes to rest in flow)');
  // A web font swaps in: every chip has another width.
  assert.equal(typeof fontsLoaded, 'function');
  h.state.boxes.rating = [151.6, 250.35, 42.8, 44.25];
  fontsLoaded();
  timers.due(120);
  h.settle();
  assert.deepEqual(h.snap('rating'), [px(nudge(151.6)), px(nudge(250.35))]);
});

test('a scroll reads no layout, and neither a scroll nor the pointer nor focus has a card measured again', t => {
  const h = setup(t);
  h.show();
  const passes = h.layout.snapStats().passes;
  const cardEl = h.document.querySelector('.card');
  h.state.reads = 0;
  for (const type of ['scroll', 'wheel', 'touchmove']) cardEl.dispatchEvent(new h.window.Event(type, { bubbles: true }));
  h.window.dispatchEvent(new h.window.Event('scroll'));
  h.document.dispatchEvent(new h.window.Event('scroll'));
  h.settle();
  assert.equal(h.state.reads, 0, 'nothing is read while the page scrolls');
  // (The pointer on a card reads its layout for the genre names it reveals, as it always did; the whole-pixel pass stays out of it.)
  for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout']) cardEl.dispatchEvent(new h.window.Event(type, { bubbles: true }));
  h.settle();
  assert.equal(h.layout.snapStats().waiting, 0);
  assert.equal(h.layout.snapStats().passes, passes);
});

test('what the styles say of the pixel grid is read once for each element, not on every pass', t => {
  const h = setup(t);
  h.show();
  h.styled.reads = 0;
  h.layout.removeGroup(h.host, 'ageRating');
  h.settle();
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15)), px(nudge(250.35))]);
  assert.equal(h.styled.reads, 0, 'the card was measured again from boxes alone');
});

test('a box that is moved moves the grid with it, by transform or by translate, and is read again on every pass', t => {
  const h = setup(t);
  // A theme takes the image box's containment away: the grid starts further up (here at the page's corner), and the
  // card's box in between is moved by a fraction of a pixel.
  const box = h.document.querySelector('.cardBox');
  h.styled.of.set(h.root, {});
  h.styled.of.set(box, { transform: 'matrix(1, 0, 0, 1, 0.25, 0.5)' });
  h.show();
  const at = (name, dx, dy) => [px(nudge(ROOT[0] + BOXES[name][0] - dx)), px(nudge(ROOT[1] + BOXES[name][1] - dy))];
  assert.deepEqual(h.snap('rating'), at('rating', 0.25, 0.5));
  // The move is another one by the next pass (a transition, a row that slides): it is not remembered.
  h.styled.of.set(box, { transform: 'matrix(1, 0, 0, 1, 0.75, 0.125)' });
  h.layout.removeGroup(h.host, 'ageRating');
  h.settle();
  assert.deepEqual(h.snap('rating'), at('rating', 0.75, 0.125));
  // `translate` is not part of the computed transform, and moves the grid just the same; with a transform, both do.
  h.styled.of.set(box, { transform: 'none', translate: '0.375px 0.625px' });
  h.add('status');
  h.settle();
  assert.deepEqual(h.snap('rating'), at('rating', 0.375, 0.625));
  h.styled.of.set(box, { transform: 'matrix(1, 0, 0, 1, 0, 0.25)', translate: '0.375px' });
  h.layout.removeGroup(h.host, 'status');
  h.settle();
  assert.deepEqual(h.snap('rating'), at('rating', 0.375, 0.25));
  // A percentage is of the box's own size.
  const boxes = h.window.Element.prototype.getBoundingClientRect;
  h.window.Element.prototype.getBoundingClientRect = function () { return this === box ? { left: 0, top: 0, width: 150, height: 250 } : boxes.call(this); };
  h.styled.of.set(box, { transform: 'none', translate: '0.5% 0.25%' });
  h.add('status');
  h.settle();
  assert.deepEqual(h.snap('rating'), at('rating', 0.75, 0.625));
  h.window.Element.prototype.getBoundingClientRect = boxes;
  h.layout.removeGroup(h.host, 'status');
  h.settle();
  // A scale or a rotation that changes nothing starts no grid; one that does starts its own, at the box's corner.
  h.styled.of.set(box, { transform: 'none', translate: 'none', scale: '1', rotate: '0deg' });
  h.add('status');
  h.settle();
  assert.deepEqual(h.snap('rating'), at('rating', 0, 0));
  // (What an element that makes no move says is remembered: this pass read the box's styles, the next does not.)
  h.styled.reads = 0;
  h.layout.removeGroup(h.host, 'status');
  h.settle();
  assert.equal(h.styled.reads, 0);
});

test('a box with a scale or a rotation that is more than nothing starts a grid of its own', t => {
  for (const given of [{ scale: '1.05' }, { scale: '1 1.2' }, { rotate: '0.5deg' }, { rotate: 'x 12deg' }]) {
    const h = setup(t);
    const box = h.document.querySelector('.cardBox');
    h.styled.of.set(h.root, {});
    h.styled.of.set(box, given);
    const corner = h.window.Element.prototype.getBoundingClientRect;
    h.window.Element.prototype.getBoundingClientRect = function () { return this === box ? { left: ROOT[0] - 0.4, top: ROOT[1] - 0.2, width: 10, height: 10 } : corner.call(this); };
    h.show();
    assert.deepEqual(h.snap('rating'), [px(nudge(BOXES.rating[0] + 0.4)), px(nudge(BOXES.rating[1] + 0.2))], JSON.stringify(given));
  }
});

test('a scaled card is not measured: distances read under a scale are not the layout\'s. It is measured when that ends', t => {
  const timers = handTimers();
  const h = setup(t, { globals: timers.globals });
  h.show();
  const before = h.snap('rating');
  // The card grows under the pointer (a theme's hover effect) while a tag arrives.
  h.state.zoom = 1.05;
  h.add('status');
  h.settle();
  assert.deepEqual(h.snap('rating'), before, 'left as it was');
  assert.deepEqual(h.snap('status'), ['', '']);
  assert.equal(h.layout.snapStats().deferred, 1);
  // While the pointer is on the card, what happens inside it is not the end of that: the pointer leaving one of the
  // card's buttons for another, focus moving between them, the transition that brought the card to its hover size.
  const cardEl = h.document.querySelector('.card');
  const inner = cardEl.querySelector('.cardImageContainer');
  const button = h.document.createElement('button');
  inner.appendChild(button);
  const matches = cardEl.matches.bind(cardEl);
  let hovered = true;
  cardEl.matches = (selector) => (selector === ':hover' ? hovered : matches(selector));
  const passes = h.layout.snapStats().passes;
  const quiet = () => { timers.due(120); h.settle(); return [h.layout.snapStats().passes, h.layout.snapStats().deferred, h.layout.snapStats().waiting]; };
  inner.dispatchEvent(new h.window.Event('pointerleave'));
  assert.deepEqual(quiet(), [passes, 1, 0], 'the pointer left a descendant, not the card');
  button.dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: inner }));
  assert.deepEqual(quiet(), [passes, 1, 0], 'focus stayed in the card');
  for (const type of ['transitionend', 'transitioncancel', 'animationend', 'animationcancel']) cardEl.dispatchEvent(new h.window.Event(type, { bubbles: true }));
  inner.dispatchEvent(new h.window.Event('transitionend', { bubbles: true }));
  assert.deepEqual(quiet(), [passes, 1, 0], 'a transition ended with the pointer still on the card');
  // The pointer leaves the card itself, and the card is back at its own size.
  hovered = false;
  h.state.zoom = 1;
  cardEl.dispatchEvent(new h.window.Event('pointerleave'));
  timers.due(120);
  h.settle();
  assert.deepEqual(h.snap('status'), [px(nudge(120.7)), '']);
  assert.deepEqual(h.snap('rating'), before);
  // Nothing is left listening on the card.
  const after = h.layout.snapStats().passes;
  cardEl.dispatchEvent(new h.window.Event('pointerleave'));
  assert.equal(quiet()[0], after);
});

test('a card a fraction of a pixel off the size it is laid out at is not measured, once the browser has said that size', t => {
  const timers = handTimers();
  const h = setup(t, { globals: timers.globals });
  h.show();
  const cardEl = h.document.querySelector('.card');
  // The size observer has reported the card's box, to the layout unit.
  h.sized(h.host, HOST[0], HOST[1]);
  timers.due(120);
  h.settle();
  const before = h.snap('rating');
  const passes = () => h.layout.snapStats();
  const deferred = passes().deferred;
  // A tenth of a pixel larger (the tail of a zoom): inside the rounding of the layout's whole-pixel size, but not the size reported.
  h.state.zoom = 1.0004;
  h.add('status');
  h.settle();
  assert.equal(passes().deferred, deferred + 1, 'it waits');
  assert.deepEqual(h.snap('status'), ['', '']);
  assert.deepEqual(h.snap('rating'), before);
  h.state.zoom = 1;
  cardEl.dispatchEvent(new h.window.Event('transitionend', { bubbles: true }));
  timers.due(120);
  h.settle();
  assert.deepEqual(h.snap('status'), [px(nudge(120.7)), '']);
  // A report that is not this layout's size (the card has another size since, to be reported next frame) is not gone by.
  h.sized(h.host, HOST[0] + 30, HOST[1]);
  timers.due(120);
  h.settle();
  h.layout.removeGroup(h.host, 'status');
  h.settle();
  assert.equal(passes().deferred, deferred + 1, 'measured, not taken for scaled');
});

test('a card on its way back from its hover size is measured when it has arrived, not when the pointer leaves', t => {
  const timers = handTimers();
  const h = setup(t, { globals: timers.globals });
  h.show();
  h.state.zoom = 1.05;
  h.add('status');
  h.settle();
  assert.equal(h.layout.snapStats().deferred, 1);
  const cardEl = h.document.querySelector('.card');
  const passes = h.layout.snapStats().passes;
  // The pointer leaves: the card starts back, and for the last frames of that it is a hair off its size, too little
  // to tell from not scaled. The transition is still running, so nothing is measured.
  let running = [{ playState: 'running', transitionProperty: 'transform' }];
  cardEl.getAnimations = (options) => { assert.equal(options.subtree, true); return running; };
  h.state.zoom = 1.002;
  cardEl.dispatchEvent(new h.window.Event('pointerleave'));
  timers.due(120);
  h.settle();
  assert.equal(h.layout.snapStats().passes, passes);
  assert.deepEqual(h.snap('status'), ['', '']);
  // A transition of something else (a colour) is no reason to wait, nor an animation that never ends.
  running = [{ playState: 'running', transitionProperty: 'opacity' }, { playState: 'running', animationName: 'spin' }, { playState: 'finished', transitionProperty: 'transform' }];
  h.state.zoom = 1;
  cardEl.querySelector('.cardImageContainer').dispatchEvent(new h.window.Event('transitionend', { bubbles: true }));
  timers.due(120);
  h.settle();
  assert.deepEqual(h.snap('status'), [px(nudge(120.7)), ''], 'measured at its own size');
  // And with only those running, the pointer leaving is the end of it.
  h.state.zoom = 1.05;
  h.layout.removeGroup(h.host, 'ageRating');
  h.settle();
  h.state.zoom = 1;
  cardEl.dispatchEvent(new h.window.Event('pointerleave'));
  timers.due(120);
  h.settle();
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15)), px(nudge(250.35))]);
  // Focus leaving a card that grew for it: the same wait for the way back.
  h.state.zoom = 1.05;
  h.add('ageRating', 'age-rating-overlay-container');
  h.settle();
  const waited = h.layout.snapStats().passes;
  running = [{ playState: 'running', transitionProperty: 'scale' }];
  h.state.zoom = 1.002;
  cardEl.dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: h.document.body }));
  timers.due(120);
  h.settle();
  assert.equal(h.layout.snapStats().passes, waited, 'not measured on its way back');
  running = [];
  h.state.zoom = 1;
  cardEl.dispatchEvent(new h.window.Event('transitionend', { bubbles: true }));
  timers.due(120);
  h.settle();
  assert.ok(h.layout.snapStats().passes > waited, 'measured once it is back');
});

test('a scaled card whose scale ends with a transition is measured when it ends, the pointer gone', t => {
  const timers = handTimers();
  const h = setup(t, { globals: timers.globals });
  h.show();
  h.state.zoom = 1.05;
  h.add('status');
  h.settle();
  assert.equal(h.layout.snapStats().deferred, 1);
  // The pointer has left already (the card was measured mid-way back): the end of the transition is what is left to hear.
  const cardEl = h.document.querySelector('.card');
  h.state.zoom = 1;
  cardEl.querySelector('.cardImageContainer').dispatchEvent(new h.window.Event('transitionend', { bubbles: true }));
  timers.due(120);
  h.settle();
  assert.deepEqual(h.snap('status'), [px(nudge(120.7)), '']);
  // Focus going outside the card ends it as well.
  h.state.zoom = 1.05;
  h.layout.removeGroup(h.host, 'ageRating');
  h.settle();
  assert.equal(h.layout.snapStats().deferred, 2);
  h.state.zoom = 1;
  cardEl.dispatchEvent(new h.window.FocusEvent('focusout', { bubbles: true, relatedTarget: h.document.body }));
  timers.due(120);
  h.settle();
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15)), px(nudge(250.35))]);
});

test('a container with no box is written nothing, and loses the nudge it had', async t => {
  const h = setup(t);
  h.show();
  assert.notDeepEqual(h.snap('rating'), ['', '']);
  // Hidden by the fitting pass, or its chips became the slot's own items.
  h.state.boxes.rating = null;
  h.layout.removeGroup(h.host, 'ageRating');
  h.settle();
  assert.deepEqual(h.snap('rating'), ['', '']);
});

test('the switch: with whole pixels off, cards presented again carry no nudge', t => {
  const h = setup(t);
  h.show();
  h.layout.wholePixels = false;
  h.layout.refreshPresentation();
  h.settle();
  for (const name of ['genre', 'rating', 'ageRating']) assert.deepEqual(h.snap(name), ['', '']);
  h.layout.wholePixels = true;
  h.layout.refreshPresentation();
  h.settle();
  assert.deepEqual(h.snap('rating'), [px(nudge(154.15)), px(nudge(250.35))]);
});

test('a card about to be fitted is un-nudged first, so the fitting pass reads the layout as it is, and is measured after it', async t => {
  const timers = handTimers();
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1 }, globals: timers.globals });
  h.show();
  await h.apply({ tagLayout: 'caption', tagEdgeSpacing: 'default' });
  h.render();
  h.add('status');
  h.settle();
  assert.equal(h.host.dataset.jeLayout, 'caption');
  const nudged = () => [...h.host.querySelectorAll('.je-tag-slot > [data-je-group]')].filter(el => el.style.getPropertyValue('--je-snap-x') || el.style.getPropertyValue('--je-snap-y'));
  assert.ok(nudged().length > 0, 'the poster stack is nudged like a corner');
  // The fitting pass starts by reading each card's height: what the containers carry at that moment is what it measures with.
  const seen = [];
  Object.defineProperty(h.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get() { if (this === h.host) seen.push(nudged().length); return this === h.host ? h.state.host[1] : 0; } });
  // The window gets another height (a phone's address bar going away as the page scrolls): no card's tags depend on
  // it, so no card is fitted again and none loses its nudges.
  const passes = h.layout.snapStats().passes;
  h.window.innerHeight += 56;
  h.window.dispatchEvent(new h.window.Event('resize'));
  h.settle();
  timers.due(400);
  h.settle();
  assert.deepEqual(seen, [], 'no fit for a height-only resize');
  assert.ok(nudged().length > 0, 'and the nudges stay on');
  assert.equal(h.layout.snapStats().passes, passes, 'nothing measured again');
  // Taller than wide now (a window turned, at the same width): orientation rules may apply, so cards are fitted.
  h.window.innerHeight = h.window.innerWidth + 200;
  h.window.dispatchEvent(new h.window.Event('resize'));
  h.settle();
  assert.ok(seen.length > 0, 'fitted when the orientation changes');
  timers.due(120);
  h.settle();
  seen.length = 0;
  // Another width: the card is fitted again. The frame that queues the fit takes the nudges off.
  h.window.innerWidth += 120;
  h.window.dispatchEvent(new h.window.Event('resize'));
  h.settle();
  assert.ok(seen.length > 0, 'the card was fitted');
  assert.deepEqual(seen.filter(Boolean), [], 'with no nudge on');
  assert.ok(nudged().length > 0, 'and they are back once it has been fitted');
  // A whole-pixel pass that is already due when a fit is queued leaves the card to the fit, whichever runs first.
  seen.length = 0;
  h.state.boxes.status = [118.2, 50, 76.2, 24.9];
  h.sized(h.group('status'), 76.2, 24.9);
  timers.due(120);
  h.layout.removeGroup(h.host, 'quality');
  h.settle();
  assert.ok(seen.length > 0);
  assert.deepEqual(seen.filter(Boolean), [], 'the pass before the fit wrote nothing for the fit to read');
  assert.deepEqual(h.snap('status'), [px(nudge(118.2)), '']);
});

/**
 * A line of Bands' top band as the browser lays it out, in layout units (64ths of a pixel): each group's width and
 * its margins left and right (null: auto). The auto margins share the free space in whole units, one after the
 * other: each takes its share of what is left, so the last takes all that remains.
 * @returns {number[]} Where each group's box starts, from the line's start.
 */
function bandLine(widths, margins, room, gap = 0) {
  const lengths = margins.flat().filter(m => m !== null);
  let autos = margins.flat().length - lengths.length;
  let free = Math.max(0, room - widths.reduce((a, b) => a + b, 0) - gap * (widths.length - 1) - lengths.reduce((a, b) => a + b, 0));
  const auto = () => { const share = Math.floor(free / autos); free -= share; autos--; return share; };
  const starts = [];
  let x = 0;
  widths.forEach((width, i) => { x += margins[i][0] ?? auto(); starts.push(x); x += width + (margins[i][1] ?? auto()) + gap; });
  return starts;
}

/** A card in Bands whose top band is laid out by `bandLine` from the margins its groups carry. Widths in layout units. */
async function bands(t, widths, timers) {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1 }, globals: timers ? timers.globals : {} });
  await h.apply({ tagLayout: 'bands', tagEdgeSpacing: 'default', tagLayouts: { bands: { groups: Object.keys(widths).map(group => ({ group, slot: 'top' })) } } });
  // The band's box starts between pixels and runs to the card's right edge, with 6px of padding inside; no gap between groups here.
  h.state.slotBox = [0.296875, HOST[0]];
  const start = 403, room = Math.round((HOST[0] - 6) * 64) - start;
  const units = (el, name) => Math.round((parseFloat(el.style.getPropertyValue(name)) || 0) * 64);
  const line = () => [...h.host.querySelector('.je-tag-slot[data-je-slot="top"]').children].filter(el => el.dataset.jeGroup);
  /** Where the line's groups start (units from the image box's corner) with the margins they carry, or with none. */
  h.lie = (bare = false) => {
    const groups = line();
    const margins = groups.map((el, i) => {
      const snap = bare ? 0 : units(el, '--je-snap-x'), left = bare ? '' : el.style.getPropertyValue('--je-band-left');
      // The band's first group: the nudge on its left, an auto margin on its right. The others: an auto margin or a length on the left, minus the nudge on the right.
      return i === 0 ? [snap, null] : [left ? units(el, '--je-band-left') : null, -snap];
    });
    return bandLine(groups.map(el => widths[el.dataset.jeGroup]), margins, room).map(x => start + x);
  };
  h.state.xOf = group => (group.parentElement.dataset.jeSlot === 'top' ? h.lie()[line().indexOf(group)] / 64 : null);
  // The room inside the band's padding (6px each side, 6px above and 16px below), as a pass measures it.
  h.room = [HOST[0] - 0.296875 - 12, HOST[1] - 12 - 22];
  // The page's clock, by hand.
  h.clock = { now: 1000 };
  h.window.performance.now = () => h.clock.now;
  h.state.boxes = { ...BOXES };
  for (const [name, width] of Object.entries(widths)) h.state.boxes[name] = [0, 6.4, width / 64, 20];
  h.line = line;
  h.band = name => ['--je-snap-x', '--je-band-left', '--je-snap-y'].map(prop => h.group(name).style.getPropertyValue(prop));
  h.draw = () => { h.render(); if (widths.status) h.add('status'); if (widths.logos) h.add('logos', 'logo-overlay-container'); if (widths.custom) h.add('custom', 'custom-overlay-container'); };
  return h;
}

test('Bands\' top band: two groups on a line are held by its ends, and each moves through the margin it has', async t => {
  const h = await bands(t, { status: 4717, ageRating: 1793 });
  h.draw();
  h.grid();
  h.settle();
  assert.equal(h.host.dataset.jeLayout, 'bands');
  assert.deepEqual(h.line().map(el => el.dataset.jeGroup), ['status', 'ageRating']);
  // Two auto margins share 5529 units: 2764, then the 2765 that remain.
  const bare = h.lie(true);
  assert.deepEqual(bare, [403, 403 + 4717 + 2764 + 2765]);
  // The badge moves 19 units left through its left margin; the age rating 25 through its right one.
  assert.deepEqual(h.band('status'), [px(-19 / 64), '', px(nudge(6.4))]);
  assert.deepEqual(h.band('ageRating'), [px(-25 / 64), '', px(nudge(6.4))]);
  assert.deepEqual(h.lie(), [384, bare[1] - 25], 'both on whole pixels: 6 and 166');
  assert.deepEqual(h.offGrid(), []);
});

test('Bands\' top band: a group between the ends gets its auto margin as a length, and one that never was contained stays exactly where it is', async t => {
  const h = await bands(t, { status: 4717, ageRating: 1793, logos: 1300, custom: 1522 });
  h.draw();
  h.grid();
  h.settle();
  assert.deepEqual(h.line().map(el => el.dataset.jeGroup), ['status', 'ageRating', 'logos', 'custom']);
  const bare = h.lie(true);
  // Four auto margins share 2707 units: 676, 677, 677, 677.
  assert.deepEqual(bare, [403, 403 + 4717 + 676 + 677, 6473 + 1793 + 677, 8943 + 1300 + 677]);
  assert.deepEqual(bare.map(x => x % 64), [19, 9, 47, 40]);
  assert.deepEqual(h.band('status'), [px(-19 / 64), '', px(nudge(6.4))]);
  // The second group shares what is left of the line with the first, whatever that comes to: it is held by the third.
  assert.deepEqual(h.band('ageRating'), [px(-9 / 64), '', px(nudge(6.4))]);
  // The third: its auto margin (677) as a length, with the 17 units it moves right.
  assert.deepEqual(h.band('logos'), [px(17 / 64), px((677 + 17) / 64), px(nudge(6.4))]);
  // The custom tag: no nudge of its own, its auto margin as the length it had.
  assert.deepEqual(h.band('custom'), ['', px(677 / 64), '']);
  assert.deepEqual(h.lie(), [384, 6464, 8960, bare[3]], 'the badge at 6, the age rating at 101, the logo at 140, the custom tag where it was');
});

test('Bands\' top band: a line with no room to spare is left as it is across', async t => {
  // The two groups nearly fill the band: the auto margins hold a third of a pixel between them.
  const h = await bands(t, { status: 4717, ageRating: 7300 });
  h.draw();
  h.grid();
  h.settle();
  assert.deepEqual(h.lie(true), [403, 403 + 4717 + 11 + 11]);
  assert.deepEqual(h.band('status'), ['', '', px(nudge(6.4))], 'only the vertical nudge, which takes no room');
  assert.deepEqual(h.band('ageRating'), ['', '', px(nudge(6.4))]);
});

test('Bands\' top band: lengths do not follow a card that changes size, so they come off the moment one does', async t => {
  const timers = handTimers();
  const h = await bands(t, { status: 4717, ageRating: 1793, custom: 2822 }, timers);
  h.draw();
  h.grid();
  h.settle();
  const before = h.band('custom');
  assert.notEqual(before[1], '', 'the third group of the line carries a length');
  const top = h.host.querySelector('.je-tag-slot[data-je-slot="top"]');
  assert.equal(h.watching(top).length, 1, 'the band\'s own box is watched: its padding follows Jellyfin\'s indicators');
  // The first report is the room the pass measured in.
  h.sized(top, h.room[0], h.room[1]);
  assert.deepEqual(h.band('custom'), before);
  // Some time later an indicator arrives: the band has less room inside its padding.
  h.clock.now += 5000;
  h.sized(top, h.room[0] - 30, h.room[1]);
  assert.deepEqual(h.band('status'), ['', '', ''], 'before the frame that reports it is painted');
  assert.deepEqual(h.band('custom'), ['', '', '']);
  timers.due(120);
  h.settle();
  assert.deepEqual(h.band('custom'), before, 'and measured again once the size has held');
});

test('Bands\' top band: a band whose own size its margins changed is left as it is across, until it changes size for another reason', async t => {
  const timers = handTimers();
  const h = await bands(t, { status: 4717, ageRating: 1793, custom: 2822 }, timers);
  h.draw();
  h.grid();
  h.settle();
  const top = h.host.querySelector('.je-tag-slot[data-je-slot="top"]');
  const nudged = h.band('ageRating');
  assert.notEqual(nudged[0], '');
  const passes = () => h.layout.snapStats().passes;
  // The frame after the margins were written the band is another height than the pass measured: a group changed
  // lines because of them. (Its first report: there is no earlier one to hold it against, only the pass's own reading.)
  h.clock.now += 30;
  h.sized(top, h.room[0], h.room[1] - 18);
  assert.deepEqual(h.band('ageRating'), ['', '', ''], 'the margins come off at once');
  // ... and the band is its old height again, which is its own doing too.
  h.clock.now += 30;
  h.sized(top, h.room[0], h.room[1]);
  timers.due(120);
  h.settle();
  assert.deepEqual(h.band('status'), ['', '', px(nudge(6.4))], 'measured again, it takes no margin across: only up and down');
  assert.deepEqual(h.band('ageRating'), ['', '', px(nudge(6.4))]);
  assert.deepEqual(h.band('custom'), ['', '', '']);
  const settled = passes();
  h.settle();
  assert.equal(passes(), settled, 'and nothing more is asked of it');
  assert.equal(h.layout.snapStats().held, 1);
  // Much later the band changes size for a reason of its own (the window, an indicator): it is nudged as any band.
  h.clock.now += 60000;
  h.sized(top, h.room[0] + 1, h.room[1]);
  timers.due(120);
  h.settle();
  assert.deepEqual(h.band('ageRating'), nudged);
});

test('Bands\' top band: a line more because of what the band holds is no doing of its margins, however soon after them', async t => {
  // A tag drawn late, or an image that arrived, right after a pass: the band is taller, and one of its groups is
  // another size. It is measured again like any band that changed, not left as it is across.
  const timers = handTimers();
  const h = await bands(t, { status: 4717, ageRating: 1793, custom: 2822 }, timers);
  h.draw();
  h.grid();
  h.settle();
  const top = h.host.querySelector('.je-tag-slot[data-je-slot="top"]');
  assert.notEqual(h.band('ageRating')[0], '');
  // (Its first report, as the pass's frame is laid out.)
  h.sized(top, h.room[0], h.room[1]);
  h.clock.now += 100;
  h.state.boxes.status = [0, 6.4, 4717 / 64, 38];
  h.sized(top, h.room[0], h.room[1] + 18);
  assert.deepEqual(h.band('ageRating'), ['', '', ''], 'the lengths come off for a band that changed, as always');
  timers.due(120);
  h.settle();
  assert.equal(h.layout.snapStats().held, 0, 'not held');
  assert.notEqual(h.band('ageRating')[0], '', 'and nudged across again');
  // The same when that report is the band's first (it was not watched before this pass).
  const g = await bands(t, { status: 4717, ageRating: 1793, custom: 2822 }, timers);
  g.draw();
  g.grid();
  g.settle();
  const band = g.host.querySelector('.je-tag-slot[data-je-slot="top"]');
  g.clock.now += 100;
  g.state.boxes.status = [0, 6.4, 4717 / 64, 38];
  g.sized(band, g.room[0], g.room[1] + 18);
  timers.due(120);
  g.settle();
  assert.equal(g.layout.snapStats().held, 0);
});

test('Bands\' top band: a first report that is not the pass\'s reading to the last unit holds nothing', async t => {
  // On a screen of 1.25 or 1.5 device pixels to a CSS pixel an observer reports a size in 64ths of a CSS pixel,
  // and a measured box is a little off that: a fraction of a pixel is not a line.
  const timers = handTimers();
  const h = await bands(t, { status: 4717, ageRating: 1793, custom: 2822 }, timers);
  h.draw();
  h.grid();
  h.settle();
  const top = h.host.querySelector('.je-tag-slot[data-je-slot="top"]');
  const nudged = h.band('ageRating');
  assert.notEqual(nudged[0], '');
  const passes = h.layout.snapStats().passes;
  h.clock.now += 10;
  h.sized(top, h.room[0] - 0.0104, h.room[1] + 0.0104);
  timers.due(120);
  h.settle();
  assert.deepEqual(h.band('ageRating'), nudged, 'the margins stay');
  assert.equal(h.layout.snapStats().passes, passes, 'and nothing is measured again');
  // The next report is held against that one: the same size is no change, another size is.
  h.clock.now += 10;
  h.sized(top, h.room[0] - 0.0104, h.room[1] + 0.0104);
  assert.deepEqual(h.band('ageRating'), nudged);
  h.clock.now += 5000;
  h.sized(top, h.room[0] - 0.5, h.room[1] + 0.0104);
  assert.deepEqual(h.band('ageRating'), ['', '', ''], 'lengths come off for a band of another width');
  timers.due(120);
  h.settle();
  assert.notEqual(h.band('ageRating')[0], '', 'and it is nudged again, not held');
});
