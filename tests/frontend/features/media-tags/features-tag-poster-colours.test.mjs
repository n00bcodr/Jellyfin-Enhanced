import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// The Poster Tag Styles preset on the web: the dominant-colour algorithm
// (shared with PosterColour.cs; tests/poster/parity compares the two), the
// artwork keys, sampling in idle slices with the cache and its invalidation,
// the tainted-canvas fallback, and the static rules tag-styles.js adds.

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const img = (id, tag = 't1') => `http://jellyfin.test/Items/${id}/Images/Primary?fillHeight=300&fillWidth=200&quality=96&tag=${tag}`;
/** The debounced store write and the watch sweep (tags/tag-poster-colours.js). */
const PERSIST_MS = 2000;
const SWEEP_MS = 3000;
const card = (id, tag = 't1') => `<div class="card portraitCard" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardContent"><div class="cardImageContainer coveredImage"><div><img src="${img(id, tag)}"></div></div></div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="je-tag-caption"></div><div class="cardText">Title</div></div></div>`;

/** RGBA pixels from a paint function. */
function pixels(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return data;
}

/**
 * Stubbed image decoding: every <img> is loaded at 200×300, createImageBitmap
 * records each decode and the canvas returns the pixels `art` maps the image
 * URL to (or throws its error). Observers still observing are counted.
 */
function stubImages(w, art) {
  const decoded = [];
  const draws = [];
  const observing = new Set();
  w.MutationObserver = class extends w.MutationObserver {
    observe(...args) { observing.add(this); return super.observe(...args); }
    disconnect() { observing.delete(this); return super.disconnect(); }
  };
  Object.defineProperty(w.HTMLImageElement.prototype, 'complete', { configurable: true, get() { return true; } });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get() { return 200; } });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get() { return 300; } });
  w.createImageBitmap = async (source, options) => { decoded.push({ url: source.src, ...options }); return { url: source.src, close() {} }; };
  w.HTMLCanvasElement.prototype.getContext = function () {
    let drawn = null;
    return {
      clearRect() {}, drawImage(source) { drawn = source.url || source.src; draws.push(drawn); },
      getImageData: (x, y, width, height) => {
        const source = art[drawn];
        if (source instanceof Error) throw source;
        return { data: source ? source(width, height) : pixels(width, height, () => [0, 0, 0, 0]) };
      },
    };
  };
  return { decoded, draws, observing };
}

/** Hold the watch sweep's timer: run it with the returned function. */
function holdSweeps(w) {
  const sweeps = [];
  const realTimeout = w.setTimeout;
  w.setTimeout = (fn, ms, ...rest) => (ms === SWEEP_MS ? (sweeps.push(fn), -sweeps.length) : realTimeout(fn, ms, ...rest));
  return { sweeps, sweep: () => { const pending = sweeps.splice(0); pending.forEach(fn => fn()); return pending.length; } };
}

/** The module alone, with stubbed image decoding: `art` maps an image URL to its pixels (or an error to throw). */
function setup(t, { html = card(ID), art = {}, store = null, session = {} } = {}) {
  const h = createHarness({
    html,
    JE: { session: { getServerId: () => 's', getUserId: () => 'u', onUserChange() {}, ...session }, ...(store ? { tagCacheStore: store } : {}) },
  });
  t.after(() => h.close());
  const w = h.window;
  const { decoded, draws, observing } = stubImages(w, art);
  h.load('tags/tag-poster-colours.js');
  const P = h.JE.tagPosterColours;
  /** Let queued slices and decodes run to the end. */
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => w.setTimeout(r, 20)); };
  const box = (id = ID) => h.document.querySelector(`[data-id="${id}"] .cardBox`);
  return { ...h, P, decoded, draws, observing, settle, box };
}

const solid = rgb => (w, h) => pixels(w, h, () => [...rgb, 255]);

test('the algorithm: solid, two-tone, letterboxed, near-black, transparent and noisy artwork', t => {
  const { P } = setup(t);
  // A red poster gives a red badge with white text; its border is a lighter shade of the same hue.
  assert.deepEqual(plain(P.dominant(pixels(21, 32, () => [200, 30, 30, 255]), 21, 32)), [200, 30, 30]);
  const red = P.normalise([200, 30, 30]);
  assert.ok(red.background[0] > 2 * red.background[1], `red badge ${red.background}`);
  assert.deepEqual(plain(red.text), [255, 255, 255]);
  assert.ok(red.border[0] > red.background[0]);
  // A bright yellow poster gets black text.
  assert.deepEqual(plain(P.normalise([250, 230, 40]).text), [0, 0, 0]);
  // Two tone: the larger area wins; an equal grey area loses to colour.
  assert.deepEqual(plain(P.dominant(pixels(30, 30, x => (x < 20 ? [30, 60, 200, 255] : [200, 40, 40, 255])), 30, 30)), [30, 60, 200]);
  assert.deepEqual(plain(P.dominant(pixels(30, 30, x => (x < 15 ? [128, 128, 128, 255] : [40, 140, 60, 255])), 30, 30)), [40, 140, 60]);
  // Letterbox bars and white borders are ignored.
  const boxed = pixels(32, 48, (x, y) => (y < 15 || y >= 33 ? [0, 0, 0, 255] : x < 3 || x >= 29 ? [255, 255, 255, 255] : [20, 130, 140, 255]));
  assert.deepEqual(plain(P.dominant(boxed, 32, 48)), [20, 130, 140]);
  // Near-black, grey and transparent artwork give the neutral dark badge.
  assert.equal(P.dominant(pixels(4, 4, () => [10, 12, 14, 255]), 4, 4), null);
  assert.deepEqual(P.normalise(null), P.NEUTRAL);
  assert.deepEqual(P.normalise([100, 100, 110]), P.NEUTRAL);
  assert.equal(P.dominant(pixels(4, 4, () => [200, 30, 30, 0]), 4, 4), null);
  // Blurhash-like noise resolves deterministically.
  let seed = 7;
  const noise = pixels(32, 48, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return [seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, 255]; });
  assert.deepEqual(plain(P.dominant(noise, 32, 48)), plain(P.dominant(noise, 32, 48)));
  // Rounded half up, ties to the lower bin (as PosterColour.Dominant).
  assert.deepEqual(plain(P.dominant([200, 40, 40, 255, 201, 41, 41, 255], 2, 1)), [201, 41, 41]);
  assert.deepEqual(plain(P.dominant([200, 40, 40, 255, 40, 40, 200, 255], 2, 1)), [40, 40, 200]);
});

test('every normalised colour reaches 4.5:1 with its text', t => {
  const { P } = setup(t);
  const lum = c => c.map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
    const c = P.normalise([r, g, b]);
    assert.ok(ratio(c.text, c.background) >= 4.5, `${[r, g, b]} → ${c.background} / ${c.text}`);
  }
});

test('artwork keys follow item, image type and tag, never the requested size', t => {
  const { P } = setup(t);
  assert.equal(P.keyOf(img(ID)), `${ID}:primary:0:t1`);
  assert.equal(P.keyOf(img(ID).replace('fillHeight=300&fillWidth=200', 'fillHeight=600&fillWidth=400')), `${ID}:primary:0:t1`);
  assert.notEqual(P.keyOf(img(ID, 't2')), P.keyOf(img(ID)));
  assert.equal(P.keyOf('http://jellyfin.test/Items/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/Images/Backdrop/2?tag=x'), `${ID}:backdrop:2:x`);
  assert.equal(P.keyOf('data:image/png;base64,AAAA'), null, 'a placeholder is never sampled');
  assert.equal(P.keyOf('blob:http://jellyfin.test/1'), null);
});

test('active, a card takes its artwork colours on its .cardBox, shared with the caption strip', async t => {
  const h = setup(t, { art: { [img(ID)]: solid([200, 30, 30]) } });
  h.P.track(h.document.querySelector('.je-tag-host'));
  await h.settle();
  assert.equal(h.box().hasAttribute('data-je-poster-colour'), false, 'nothing while the preset is not active');
  h.P.setActive(true);
  await h.settle();
  const box = h.box();
  assert.equal(box.dataset.jePosterColour, '1');
  assert.equal(box.dataset.jePosterKey, `${ID}:primary:0:t1`);
  const c = h.P.normalise([200, 30, 30]);
  assert.equal(box.style.getPropertyValue('--je-tag-bg'), h.P.css(c.background));
  assert.equal(box.style.getPropertyValue('--je-tag-border'), h.P.css(c.border));
  assert.equal(box.style.getPropertyValue('--je-tag-fg'), 'rgb(255, 255, 255)');
  assert.ok(box.contains(h.document.querySelector('.je-tag-caption')), 'the caption outlet inherits the colours');
  assert.deepEqual(h.decoded.map(d => [d.resizeWidth, d.resizeHeight, d.resizeQuality]), [[21, 32, 'medium']], 'decoded small, off the main path');
  h.P.setActive(false);
  assert.equal(box.hasAttribute('data-je-poster-colour'), false);
  assert.equal(box.style.getPropertyValue('--je-tag-bg'), '');
});

test('colours are reused per artwork and resampled when the image tag changes', async t => {
  const h = setup(t, { html: card(ID) + card(ID2), art: { [img(ID)]: solid([200, 30, 30]), [img(ID, 't2')]: solid([30, 60, 200]) } });
  // The second card shows the same artwork (same item, tag), e.g. a row repeated on the page.
  h.document.querySelector(`[data-id="${ID2}"] img`).src = img(ID);
  h.P.setActive(true);
  await h.settle();
  assert.equal(h.decoded.length, 1, 'one decode for one artwork');
  assert.equal(h.box(ID2).style.getPropertyValue('--je-tag-bg'), h.box(ID).style.getPropertyValue('--je-tag-bg'));
  // New artwork for the first card: a new image tag, resampled (the card's watch sees it); the old colour never lingers.
  h.document.querySelector(`[data-id="${ID}"] img`).src = img(ID, 't2');
  await h.settle();
  assert.equal(h.decoded.length, 2);
  assert.equal(h.box(ID).dataset.jePosterKey, `${ID}:primary:0:t2`);
  assert.equal(h.box(ID).style.getPropertyValue('--je-tag-bg'), h.P.css(h.P.normalise([30, 60, 200]).background));
  const stats = h.P.stats();
  assert.ok(stats.slices >= 1 && stats.sampled === 2 && stats.fromMemory >= 1);
});

test('a tainted canvas or a broken image keeps the Default colours for that card only', async t => {
  const tainted = new Error('tainted');
  tainted.name = 'SecurityError';
  const h = setup(t, { html: card(ID) + card(ID2), art: { [img(ID)]: tainted, [img(ID2)]: solid([30, 60, 200]) } });
  h.P.setActive(true);
  await h.settle();
  assert.equal(h.box(ID).hasAttribute('data-je-poster-colour'), false);
  assert.equal(h.box(ID2).dataset.jePosterColour, '1');
  assert.equal(h.P.stats().failed, 1);
  // Not retried on every presentation.
  h.P.track(h.document.querySelector(`[data-id="${ID}"] .je-tag-host`));
  await h.settle();
  assert.equal(h.decoded.filter(d => d.url === img(ID)).length, 1);
});

test('a placeholder or a still-loading image waits for the real artwork', async t => {
  const h = setup(t, { art: { [img(ID)]: solid([30, 60, 200]) } });
  const image = h.document.querySelector('img');
  image.src = 'data:image/png;base64,AAAA';
  h.P.setActive(true);
  await h.settle();
  assert.equal(h.decoded.length, 0, 'a blurhash-like placeholder is never sampled');
  assert.equal(h.box().hasAttribute('data-je-poster-colour'), false);
  image.src = img(ID);
  await h.settle();
  assert.equal(h.decoded.length, 1, 'the real image is sampled once it arrives');
  assert.equal(h.box().dataset.jePosterColour, '1');
});

test('colours persisted for this server and user are used without decoding, new ones are stored', async t => {
  const puts = [];
  const store = {
    available: () => true,
    getPosterColours: async (scope, algorithm) => { assert.equal(scope, 's:u'); assert.equal(algorithm, 1); return new Map([[`${ID}:primary:0:t1`, [20, 130, 140]]]); },
    putPosterColours: async (...args) => { puts.push(args); },
  };
  const h = setup(t, { html: card(ID) + card(ID2), store, art: { [img(ID2)]: solid([200, 30, 30]) } });
  const realTimeout = h.window.setTimeout;
  // The store write is debounced by seconds: run it at once.
  h.window.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms === PERSIST_MS ? 0 : ms, ...rest);
  h.P.setActive(true);
  await h.settle();
  assert.deepEqual(h.decoded.map(d => d.url), [img(ID2)], 'only the artwork not stored is decoded');
  assert.equal(h.box(ID).style.getPropertyValue('--je-tag-bg'), h.P.css(h.P.normalise([20, 130, 140]).background));
  assert.equal(puts.length, 1);
  const [scope, algorithm, colours, cap] = puts[0];
  assert.equal(scope, 's:u');
  assert.equal(algorithm, 1);
  assert.deepEqual(plain([...colours]), [[`${ID2}:primary:0:t1`, [200, 30, 30]]]);
  assert.equal(cap, 2000);
});

test('declared sample colours (the settings panel preview) need no image', async t => {
  const h = setup(t, { html: '<div class="cardBox"><div class="cardScalable je-mtp-scalable"><div class="je-mtp-art" data-je-poster-rgb="181,86,47"></div><div class="je-tag-host"></div></div><div class="cardText">Movie</div></div>' });
  h.P.setActive(true);
  await h.settle();
  const box = h.document.querySelector('.cardBox');
  assert.equal(box.style.getPropertyValue('--je-tag-bg'), h.P.css(h.P.normalise([181, 86, 47]).background));
  assert.equal(h.decoded.length, 0);
});

/** [ids, classes and attributes, elements] specificity of a selector (enough for these rules). */
function specificity(selector) {
  const s = selector.replace(/:is\(([^)]*)\)/g, (_, list) => list.split(',').map(x => x.trim()).sort((a, b) => specificity(b)[1] - specificity(a)[1])[0]);
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]+\]/g) || []).length;
  return [ids, classes];
}

test('Poster rules come first and sit between the tag modules\' rules and the admin\'s overrides', t => {
  const h = createHarness({ JE: { t: key => key } });
  t.after(() => h.close());
  h.load('core/ui-kit.js');
  h.load('tags/tag-styles.js');
  const { buildCss } = h.JE.tagStyles;
  assert.equal(buildCss({ preset: 'glass' }).includes('data-je-poster-colour'), false, 'other presets have no Poster rules');
  const css = buildCss({
    preset: 'poster',
    quality: { '*': { background: 'rgba(0, 0, 255, 1)' }, '4K': { color: 'rgba(0, 255, 0, 1)' } },
    ageDefault: { background: 'rgba(1, 1, 1, 1)' },
    age: [{ ratings: ['PG'], background: 'rgba(2, 2, 2, 1)' }],
    rating: { community: { background: 'rgba(3, 3, 3, 1)' } },
    genre: { background: 'rgba(4, 4, 4, 1)' },
    status: { trending: { color: 'rgba(5, 5, 5, 1)' } },
  });
  const unguarded = css.replaceAll(':where(:not([data-je-tag-styles-scope] *))', '');
  const rules = unguarded.split('\n').map(line => ({ selector: line.slice(0, line.indexOf(' {')), line }));
  const poster = rules.filter(r => r.selector.includes('[data-je-poster-colour]'));
  const overrides = rules.filter(r => !r.selector.includes('[data-je-poster-colour]'));
  assert.ok(rules.indexOf(poster.at(-1)) < rules.indexOf(overrides[0]), 'every Poster rule precedes every override');
  const of = (list, needle) => list.find(r => r.selector.includes(needle)).selector.split(', ').map(specificity).sort((a, b) => b[1] - a[1])[0];
  const le = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]);
  // Overrides (later) win ties and higher specificity; the tag modules' own rules lose.
  for (const [needle, module] of [['.quality-overlay-label', '.quality-overlay-container .quality-overlay-label[data-quality="4K"]'], ['.age-rating-tag', '.age-rating-tag[rating="PG"]'],
    ['.rating-tag', '.rating-tag.rating-tag-tmdb'], ['.genre-tag', '.genre-tag'], ['.status-tag', '.status-tag--trending']]) {
    const p = of(poster, needle);
    for (const o of overrides.filter(r => r.selector.includes(needle) && !r.selector.includes('-icon') && !r.selector.includes('-rank'))) {
      assert.ok(le(p, of([o], needle)), `${needle}: Poster ${p} must not beat override ${o.selector}`);
    }
    assert.ok(!le(p, specificity(module)) || needle !== '.quality-overlay-label', `${needle}: Poster beats the module's ${module}`);
  }
  assert.match(unguarded, /\[data-je-poster-colour\] \.quality-overlay-container\.quality-overlay-container \.quality-overlay-label \{ background: var\(--je-tag-bg\) !important; color: var\(--je-tag-fg\) !important; border-color: var\(--je-tag-border\) !important; \}/);
  assert.match(unguarded, /\[data-je-poster-colour\] \.je-tag-pill \{ background: var\(--je-tag-bg\);/, 'the summary pill follows the artwork too');
  assert.match(css, /\[data-je-poster-colour\][^{]*\.language-chip/, 'language chips take artwork colours');
  assert.doesNotMatch(css, /\[data-je-poster-colour\][^{]*\.language-flag/, 'only flag images keep their look');
  // Scoped (the configuration page preview), the Poster rules are limited too.
  assert.ok(buildCss({ preset: 'poster' }, '#tagStylePreview').split('\n').every(line => line.startsWith('#tagStylePreview ')));
});

test('tag-styles turns the Poster colours on for the poster preset and off otherwise', async t => {
  let preset = 'poster';
  const h = createHarness({
    JE: { pluginConfig: { TagStyleWebActive: true }, currentSettings: {}, t: key => key },
    apiClient: { getUrl: path => `http://jellyfin.test/${path}`, ajax: async () => ({ preset }) },
  });
  t.after(() => h.close());
  const calls = [];
  h.JE.tagPosterColours = { setActive: on => calls.push(on) };
  h.load('core/ui-kit.js');
  h.load('tags/tag-styles.js');
  await h.JE.initializeTagStyles();
  preset = 'glass';
  await h.JE.initializeTagStyles();
  h.JE.tagStyles.deactivate();
  assert.deepEqual(calls, [true, false, false]);
  assert.ok(h.JE.tagStyles.PRESETS.includes('poster'));
});

test('an image Jellyfin mounts after the tags arrived (Jellyfin 12) is picked up', async t => {
  const h = setup(t, { html: card(ID).replace(/<div><img src="[^"]*"><\/div>/, ''), art: { [img(ID)]: solid([30, 60, 200]) } });
  h.P.setActive(true);
  await h.settle();
  assert.equal(h.box().hasAttribute('data-je-poster-colour'), false, 'no artwork yet');
  const wrap = h.document.createElement('div');
  wrap.innerHTML = `<img src="${img(ID)}">`;
  h.document.querySelector('.cardImageContainer').appendChild(wrap);
  await h.settle();
  assert.equal(h.box().dataset.jePosterColour, '1');
  assert.equal(h.decoded.length, 1);
});

test('a decode still out at a user switch is dropped: nothing shown, remembered or stored for the incoming user', async t => {
  const puts = [];
  let user = 'A';
  let reset = null;
  const store = { available: () => true, getPosterColours: async () => new Map(), putPosterColours: async (...args) => { puts.push(args); } };
  const h = setup(t, { store, session: { getUserId: () => user, onUserChange: (name, fn) => { reset = fn; } }, art: { [img(ID)]: solid([200, 30, 30]) } });
  const realTimeout = h.window.setTimeout;
  h.window.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms === PERSIST_MS ? 0 : ms, ...rest);
  // Each decode waits until the test lets it finish.
  const decode = h.window.createImageBitmap;
  const pending = [];
  h.window.createImageBitmap = (...args) => new Promise((resolve) => { pending.push(() => resolve(decode(...args))); });
  h.P.setActive(true);
  await h.settle();
  assert.equal(pending.length, 1, "user A's decode is out");
  user = 'B';
  reset({ userId: 'B', previousUserId: 'A' });
  h.P.setActive(true);
  await h.settle();
  assert.equal(pending.length, 2, 'the incoming user samples the card itself');
  pending[0]();
  await h.settle();
  assert.equal(h.box().hasAttribute('data-je-poster-colour'), false, "A's result never reaches B's card");
  assert.equal(h.P.stats().remembered, 0, "nor B's memory");
  assert.deepEqual(puts, [], "nor B's store");
  pending[1]();
  await h.settle();
  assert.equal(h.box().dataset.jePosterColour, '1');
  assert.deepEqual(plain(puts.map(([scope, , colours]) => [scope, [...colours.keys()]])), [['s:B', [`${ID}:primary:0:t1`]]]);
});

test('a store write still pending at a user switch is dropped', async t => {
  const puts = [];
  let user = 'A';
  let reset = null;
  const store = { available: () => true, getPosterColours: async () => new Map(), putPosterColours: async (...args) => { puts.push(args); } };
  const h = setup(t, { store, session: { getUserId: () => user, onUserChange: (name, fn) => { reset = fn; } }, art: { [img(ID)]: solid([200, 30, 30]) } });
  const timers = [];
  const realTimeout = h.window.setTimeout;
  // Hold the debounced write; slices run as usual.
  h.window.setTimeout = (fn, ms, ...rest) => (ms === PERSIST_MS ? (timers.push(fn), timers.length) : realTimeout(fn, ms, ...rest));
  h.P.setActive(true);
  await h.settle();
  assert.equal(timers.length, 1, "A's colour waits to be written");
  user = 'B';
  reset({ userId: 'B', previousUserId: 'A' });
  timers[0]();
  assert.deepEqual(puts, []);
});

test('a loaded image replaced in place is resampled without the card being presented again', async t => {
  const h = setup(t, { art: { [img(ID)]: solid([200, 30, 30]), [img(ID, 't2')]: solid([30, 60, 200]) } });
  h.P.setActive(true);
  await h.settle();
  assert.equal(h.box().dataset.jePosterKey, `${ID}:primary:0:t1`);
  assert.equal(h.P.stats().watching, 1, 'an image that was already loaded is watched too');
  const image = h.document.querySelector('img');
  image.setAttribute('srcset', `${img(ID, 't2')} 1x`);
  image.src = img(ID, 't2');
  await h.settle();
  assert.equal(h.box().dataset.jePosterKey, `${ID}:primary:0:t2`);
  assert.equal(h.box().style.getPropertyValue('--je-tag-bg'), h.P.css(h.P.normalise([30, 60, 200]).background));
  // The card's own colour writes and chips are not artwork changes.
  const slices = h.P.stats().slices;
  h.document.querySelector('.je-tag-host').appendChild(h.document.createElement('span'));
  h.box().style.setProperty('--je-tag-bg', 'rgb(1, 2, 3)');
  await h.settle();
  assert.equal(h.P.stats().slices, slices);
});

test('on a bare image (a list row), the card\'s chips and colour writes are not artwork changes', async t => {
  const row = (id, tag = 't1') => `<div class="listItem" data-id="${id}"><div class="listItemImage listItemImage-large" style="background-image: url('${img(id, tag)}')"><div class="je-tag-host"></div></div></div>`;
  const h = setup(t, { html: row(ID), art: { [img(ID)]: solid([200, 30, 30]), [img(ID, 't2')]: solid([30, 60, 200]) } });
  h.window.HTMLImageElement.prototype.decode = () => Promise.resolve();
  holdSweeps(h.window);
  h.P.setActive(true);
  await h.settle();
  const target = h.document.querySelector('.listItemImage');
  assert.equal(target.dataset.jePosterKey, `${ID}:primary:0:t1`, 'the row image is the colour target');
  const { rechecks, slices } = h.P.stats();
  // Reading the row's artwork queries the row image: count those queries.
  let queries = 0;
  const query = target.querySelector;
  target.querySelector = function (...args) { queries++; return query.apply(this, args); };
  // Chips come and go inside the host; the colours are rewritten on the row image itself.
  const host = h.document.querySelector('.je-tag-host');
  const chip = h.document.createElement('span');
  chip.innerHTML = '<span class="je-tag">4K</span>';
  host.appendChild(chip);
  chip.firstChild.textContent = 'HDR';
  target.style.setProperty('--je-tag-bg', 'rgb(1, 2, 3)');
  target.style.setProperty('--je-tag-fg', 'rgb(255, 255, 255)');
  chip.remove();
  await h.settle();
  assert.equal(queries, 0, 'the artwork is not read again');
  assert.equal(h.P.stats().rechecks, rechecks, 'no artwork check for chips or colour writes');
  assert.equal(h.P.stats().slices, slices);
  // New artwork on the row image is still seen.
  target.style.backgroundImage = `url('${img(ID, 't2')}')`;
  await h.settle();
  assert.equal(h.P.stats().rechecks, rechecks + 1);
  assert.equal(target.dataset.jePosterKey, `${ID}:primary:0:t2`);
  assert.equal(target.style.getPropertyValue('--je-tag-bg'), h.P.css(h.P.normalise([30, 60, 200]).background));
});

test('a card recycled for another item, even with a new host, takes the other item\'s colour', async t => {
  const h = setup(t, { art: { [img(ID)]: solid([200, 30, 30]), [img(ID2)]: solid([30, 60, 200]) } });
  h.P.setActive(true);
  await h.settle();
  const blue = h.P.css(h.P.normalise([30, 60, 200]).background);
  // A virtual list reuses the card: new item id, then its image.
  const el = h.document.querySelector('.card');
  el.setAttribute('data-id', ID2);
  h.document.querySelector('img').src = img(ID2);
  await h.settle();
  assert.equal(h.box(ID2).dataset.jePosterKey, `${ID2}:primary:0:t1`);
  assert.equal(h.box(ID2).style.getPropertyValue('--je-tag-bg'), blue);
  // Recycled again, its host replaced: the new host owns the watch.
  const old = h.document.querySelector('.je-tag-host');
  const fresh = h.document.createElement('div');
  fresh.className = 'je-tag-host';
  old.replaceWith(fresh);
  el.setAttribute('data-id', ID);
  h.document.querySelector('img').src = img(ID);
  await h.settle();
  assert.equal(h.box(ID).dataset.jePosterKey, `${ID}:primary:0:t1`);
  assert.equal(h.box(ID).style.getPropertyValue('--je-tag-bg'), h.P.css(h.P.normalise([200, 30, 30]).background));
  assert.equal(h.P.stats().watching, 1);
});

test('artwork watches go with their cards: cleared, removed or switched off', async t => {
  const h = setup(t, { html: card(ID) + card(ID2), art: { [img(ID)]: solid([200, 30, 30]), [img(ID2)]: solid([30, 60, 200]) } });
  h.P.setActive(true);
  await h.settle();
  assert.equal(h.observing.size, 2);
  h.P.release(h.document.querySelector(`[data-id="${ID}"] .je-tag-host`));
  assert.equal(h.observing.size, 1, 'released with its card');
  h.P.setActive(false);
  assert.equal(h.observing.size, 0);
  assert.equal(h.P.stats().watching, 0);
});

test('a card removed while nothing is sampled loses its watch at the next sweep, without a slice', async t => {
  const h = setup(t, { html: card(ID) + card(ID2), art: { [img(ID)]: solid([200, 30, 30]), [img(ID2)]: solid([30, 60, 200]) } });
  const { sweeps, sweep } = holdSweeps(h.window);
  h.P.setActive(true);
  await h.settle();
  assert.equal(h.observing.size, 2);
  assert.equal(sweeps.length, 1, 'one sweep pending while cards are watched');
  const { slices } = h.P.stats();
  // Jellyfin drops the row: no layout call, no track, no new card.
  h.document.querySelector(`[data-id="${ID2}"]`).remove();
  h.document.querySelector(`[data-id="${ID}"]`).remove();
  await h.settle();
  assert.equal(h.P.stats().slices, slices, 'sampling has settled: no slice runs');
  assert.equal(h.P.stats().watching, 2);
  sweep();
  assert.equal(h.P.stats().watching, 0, 'released by the sweep');
  assert.equal(h.observing.size, 0, 'no observer left');
  assert.equal(sweeps.length, 0, 'no further sweep once nothing is watched');
  assert.equal(h.P.stats().slices, slices);
});

test('a host removed from a card still on the page loses its watch at the next sweep', async t => {
  const h = setup(t, { html: card(ID) + card(ID2), art: { [img(ID)]: solid([200, 30, 30]), [img(ID2)]: solid([30, 60, 200]) } });
  const { sweep } = holdSweeps(h.window);
  h.P.setActive(true);
  await h.settle();
  h.document.querySelector(`[data-id="${ID2}"] .je-tag-host`).remove();
  sweep();
  assert.equal(h.P.stats().watching, 1);
  assert.equal(h.observing.size, 1);
});

test('the layout\'s clearAll releases every card\'s artwork watch', async t => {
  const layoutCard = id => `<div class="card overflowPortraitCard" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer coveredImage cardContent"><img src="${img(id)}"></div><div class="cardOverlayContainer"></div></div><div class="cardText cardText-first">Title</div></div></div>`;
  const renderers = new Map();
  const h = createHarness({
    html: layoutCard(ID) + layoutCard(ID2),
    JE: {
      currentSettings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none' },
      pluginConfig: { TagCacheServerMode: true },
      t: key => key,
      session: { getUserId: () => 'u', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name), clearProcessed() {}, scheduleScan() {} },
    },
  });
  t.after(() => h.close());
  const { observing } = stubImages(h.window, { [img(ID)]: solid([200, 30, 30]), [img(ID2)]: solid([30, 60, 200]) });
  const { sweep } = holdSweeps(h.window);
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/qualitytags.js', 'tags/tag-poster-colours.js']) h.load(file);
  h.JE.initializeQualityTags();
  h.JE.tagPosterColours.setActive(true);
  const entry = { Type: 'Movie', StreamData: { Streams: [{ Type: 'Video', Codec: 'hevc', Height: 2160, DisplayTitle: '4K HEVC' }], Sources: [], ItemName: 'Movie' } };
  for (const id of [ID, ID2]) renderers.get('quality').renderFromServerCache(h.document.querySelector(`[data-id="${id}"] .cardScalable`), entry, id);
  for (let i = 0; i < 12; i++) await new Promise(r => h.window.setTimeout(r, 20));
  assert.equal(h.document.querySelectorAll('[data-je-poster-colour]').length, 2, 'both cards coloured through the layout');
  assert.equal(observing.size, 2);
  // One card already left the page: clearAll only finds the hosts still on it.
  h.document.querySelector(`[data-id="${ID2}"]`).remove();
  h.JE.core.tagLayout.clearAll();
  assert.equal(observing.size, 1, 'the detached card is not reached by clearAll');
  sweep();
  assert.equal(observing.size, 0, 'no observer outlives clearAll and the sweep');
  assert.equal(h.JE.tagPosterColours.stats().watching, 0);
});

test('a card arriving while its artwork is being decoded is coloured by that decode', async t => {
  const h = setup(t, { art: { [img(ID)]: solid([200, 30, 30]) } });
  const decode = h.window.createImageBitmap;
  const pending = [];
  h.window.createImageBitmap = (...args) => new Promise((resolve) => { pending.push(() => resolve(decode(...args))); });
  h.P.setActive(true);
  await h.settle();
  assert.equal(pending.length, 1);
  // A second card with the same artwork (another home row) is presented in a later slice.
  const row = h.document.createElement('div');
  row.innerHTML = card(ID2).replace(img(ID2), img(ID));
  h.document.body.appendChild(row);
  h.P.track(h.document.querySelector(`[data-id="${ID2}"] .je-tag-host`));
  await h.settle();
  assert.equal(pending.length, 1, 'no second decode');
  pending[0]();
  await h.settle();
  const red = h.P.css(h.P.normalise([200, 30, 30]).background);
  assert.equal(h.box(ID).style.getPropertyValue('--je-tag-bg'), red);
  assert.equal(h.box(ID2).style.getPropertyValue('--je-tag-bg'), red, 'both waiters coloured');
  assert.equal(h.P.stats().sampled, 1);
});

test('a card recycled while its sample waits for a decode slot: nothing stored under the old artwork, the card takes the new colour', async t => {
  const ids = Array.from({ length: 5 }, (_, i) => (i + 1).toString(16).padStart(32, '0'));
  const art = Object.fromEntries(ids.map(id => [img(id), solid([200, 30, 30])]));
  art[img(ID2)] = solid([30, 60, 200]);
  const puts = [];
  const store = { available: () => true, getPosterColours: async () => new Map(), putPosterColours: async (scope, algorithm, colours) => { puts.push(...colours); } };
  const h = setup(t, { html: ids.map(id => card(id)).join(''), art, store });
  const realTimeout = h.window.setTimeout;
  h.window.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms === PERSIST_MS ? 0 : ms, ...rest);
  // A bitmap is a copy of the image as it is when the decode starts.
  const launched = [];
  const pending = [];
  h.window.createImageBitmap = (source) => {
    const url = source.src;
    launched.push(url);
    return new Promise((resolve) => { pending.push(() => resolve({ url, close() {} })); });
  };
  h.P.setActive(true);
  await h.settle();
  assert.equal(pending.length, 4, 'every decode slot is taken; the fifth card waits');
  // The fifth card is recycled for another item before its decode starts.
  const fifth = h.document.querySelector(`[data-id="${ids[4]}"]`);
  fifth.setAttribute('data-id', ID2);
  fifth.querySelector('img').src = img(ID2);
  await h.settle();
  while (pending.length) {
    pending.shift()();
    await h.settle();
  }
  assert.equal(launched.filter(url => url === img(ID2)).length, 1, 'the new artwork is decoded once, for its own key');
  assert.equal(puts.some(([key]) => key === `${ids[4]}:primary:0:t1`), false, 'nothing stored under the old artwork');
  assert.deepEqual(plain(puts.find(([key]) => key === `${ID2}:primary:0:t1`)), [`${ID2}:primary:0:t1`, [30, 60, 200]]);
  assert.equal(h.box(ID2).dataset.jePosterKey, `${ID2}:primary:0:t1`);
  assert.equal(h.box(ID2).style.getPropertyValue('--je-tag-bg'), h.P.css(h.P.normalise([30, 60, 200]).background));
  assert.equal(h.P.stats().remembered, 5, 'four red artworks and the blue one');
});

test('a decode cancelled by Poster off and on that fails late never overwrites the newer colour', async t => {
  const h = setup(t, { art: { [img(ID)]: solid([200, 30, 30]) } });
  const decode = h.window.createImageBitmap;
  const pending = [];
  h.window.createImageBitmap = (...args) => new Promise((resolve, reject) => { pending.push({ resolve: () => resolve(decode(...args)), reject }); });
  h.P.setActive(true);
  await h.settle();
  assert.equal(pending.length, 1);
  // Off and on again (same user): the first decode is cancelled, a new one starts.
  h.P.setActive(false);
  h.P.setActive(true);
  await h.settle();
  assert.equal(pending.length, 2);
  pending[1].resolve();
  await h.settle();
  const red = h.P.css(h.P.normalise([200, 30, 30]).background);
  assert.equal(h.box().style.getPropertyValue('--je-tag-bg'), red);
  // The cancelled decode now fails (a tainted canvas fails for good).
  pending[0].reject(Object.assign(new Error('tainted'), { name: 'SecurityError' }));
  await h.settle();
  assert.equal(h.P.stats().failed, 0, 'the cancelled failure is dropped');
  // Another card with the same artwork is presented: it takes the colour from memory.
  const row = h.document.createElement('div');
  row.innerHTML = card(ID2).replace(img(ID2), img(ID));
  h.document.body.appendChild(row);
  h.P.track(h.document.querySelector(`[data-id="${ID2}"] .je-tag-host`));
  await h.settle();
  assert.equal(h.box(ID2).style.getPropertyValue('--je-tag-bg'), red);
  assert.equal(h.box().style.getPropertyValue('--je-tag-bg'), red);
  assert.equal(pending.length, 2, 'no further decode');
});

test('without createImageBitmap, 200 cards are drawn one per idle period, never once its time runs low', async t => {
  const ids = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(32, '0'));
  const art = Object.fromEntries(ids.map((id, i) => [img(id), solid([200, 30 + (i % 50), 30])]));
  const h = setup(t, { html: ids.map(id => card(id)).join(''), art });
  delete h.window.createImageBitmap;
  // The decode before drawing settles at once, as for an image already decoded: no await gives the pixel work a free pass.
  h.window.HTMLImageElement.prototype.decode = () => Promise.resolve();
  const idle = [];
  h.window.requestIdleCallback = (fn) => idle.push(fn);
  const flush = () => new Promise(r => h.window.setTimeout(r, 0));
  /** Run the next idle callback with this much time left; the drawings it made. */
  const period = async (remaining, didTimeout = false) => {
    const before = h.draws.length;
    idle.shift()({ timeRemaining: () => remaining, didTimeout });
    const drew = h.draws.length - before;
    await flush();
    return drew;
  };
  h.P.setActive(true);
  await flush();
  assert.equal(idle.length, 1);
  assert.equal(await period(50), 0, 'the first period reads cards and starts decodes');
  assert.equal(await period(3), 0, 'too little idle time: the drawing waits');
  assert.equal(await period(0, true), 1, 'a period that ran late still makes progress, one drawing');
  let periods = 3;
  while (idle.length) {
    assert.ok(await period(50) <= 1, 'one full-size drawing per idle period');
    assert.ok(++periods < 1000);
  }
  assert.equal(h.draws.length, 200);
  assert.equal(h.document.querySelectorAll('[data-je-poster-colour]').length, 200);
  const stats = h.P.stats();
  assert.equal(stats.fallback, 200);
  assert.equal(stats.steps, 200, 'the drawings ran inside the timed slices');
  assert.equal(stats.sampled, 200);
  assert.equal(stats.decoding + stats.waiting + stats.queued, 0);
});

test('every decode and bitmap launch runs inside a timed slice, for background-image and <img> cards alike', async t => {
  const bg = id => card(id).replace(/<div><img src="[^"]*"><\/div>/, '').replace('class="cardImageContainer coveredImage"', `class="cardImageContainer coveredImage" style="background-image: url('${img(id)}')"`);
  const legacy = Array.from({ length: 8 }, (_, i) => (i + 1).toString(16).padStart(32, '0'));
  const art = Object.fromEntries([...legacy, ID, ID2].map((id, i) => [img(id), solid([200, 30 + 10 * i, 30])]));
  const h = setup(t, { html: legacy.map(bg).join('') + card(ID) + card(ID2), art });
  let inSlice = false;
  const outside = [];
  const inside = [];
  const realTimeout = h.window.setTimeout;
  h.window.requestIdleCallback = (fn) => realTimeout(() => {
    inSlice = true;
    try { fn({ timeRemaining: () => 50, didTimeout: false }); } finally { inSlice = false; }
  }, 1);
  const record = (what, url) => (inSlice ? inside : outside).push([what, url]);
  const bitmap = h.window.createImageBitmap;
  h.window.createImageBitmap = (source, options) => {
    record('createImageBitmap', source.src);
    // The cards' own images cannot be resized here: drawn from the image instead.
    if (source.isConnected) return Promise.reject(Object.assign(new Error('unsupported'), { name: 'InvalidStateError' }));
    return bitmap(source, options);
  };
  h.window.HTMLImageElement.prototype.decode = function () { record('decode', this.src); return Promise.resolve(); };
  h.P.setActive(true);
  await h.settle();
  assert.equal(h.document.querySelectorAll('[data-je-poster-colour]').length, 10, 'every card coloured');
  assert.deepEqual(outside, [], 'no decode or bitmap launch from a promise callback');
  assert.equal(inside.filter(([what]) => what === 'decode').length, 10, 'each background image and each fallback image decoded once');
  assert.equal(inside.filter(([what]) => what === 'createImageBitmap').length, 10);
  const stats = h.P.stats();
  assert.equal(stats.fallback, 2, 'the two <img> cards were drawn');
  assert.equal(stats.steps, 10);
});

test('a createImageBitmap that rejects falls back to drawing the image', async t => {
  const h = setup(t, { art: { [img(ID)]: solid([30, 60, 200]) } });
  h.window.createImageBitmap = async () => { const err = new Error('unsupported'); err.name = 'InvalidStateError'; throw err; };
  h.P.setActive(true);
  await h.settle();
  assert.equal(h.box().style.getPropertyValue('--je-tag-bg'), h.P.css(h.P.normalise([30, 60, 200]).background));
  assert.equal(h.P.stats().fallback, 1);
});
