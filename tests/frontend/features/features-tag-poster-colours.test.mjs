import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

// The Poster Tag Styles preset on the web: the dominant-colour algorithm
// (shared with PosterColour.cs; tests/poster/parity compares the two), the
// artwork keys, sampling in idle slices with the cache and its invalidation,
// the tainted-canvas fallback, and the static rules tag-styles.js adds.

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const img = (id, tag = 't1') => `http://jellyfin.test/Items/${id}/Images/Primary?fillHeight=300&fillWidth=200&quality=96&tag=${tag}`;
const card = (id, tag = 't1') => `<div class="card portraitCard" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardContent"><div class="cardImageContainer coveredImage"><div><img src="${img(id, tag)}"></div></div></div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="je-tag-caption"></div><div class="cardText">Title</div></div></div>`;

/** RGBA pixels from a paint function. */
function pixels(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return data;
}

/** The module alone, with stubbed image decoding: `art` maps an image URL to its pixels (or an error to throw). */
function setup(t, { html = card(ID), art = {}, store = null, session = {} } = {}) {
  const h = createHarness({
    html,
    JE: { session: { getServerId: () => 's', getUserId: () => 'u', onUserChange() {}, ...session }, ...(store ? { tagCacheStore: store } : {}) },
  });
  t.after(() => h.close());
  const w = h.window;
  const decoded = [];
  // Every <img> is loaded at 200×300; createImageBitmap remembers the source for the canvas stub.
  Object.defineProperty(w.HTMLImageElement.prototype, 'complete', { configurable: true, get() { return true; } });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get() { return 200; } });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get() { return 300; } });
  w.createImageBitmap = async (source, options) => { decoded.push({ url: source.src, ...options }); return { url: source.src, close() {} }; };
  w.HTMLCanvasElement.prototype.getContext = function () {
    let drawn = null;
    return {
      clearRect() {}, drawImage(source) { drawn = source.url; },
      getImageData: (x, y, width, height) => {
        const source = art[drawn];
        if (source instanceof Error) throw source;
        return { data: source ? source(width, height) : pixels(width, height, () => [0, 0, 0, 0]) };
      },
    };
  };
  h.load('tags/tag-poster-colours.js');
  const P = h.JE.tagPosterColours;
  /** Let queued slices and decodes run to the end. */
  const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => w.setTimeout(r, 20)); };
  const box = (id = ID) => h.document.querySelector(`[data-id="${id}"] .cardBox`);
  return { ...h, P, decoded, settle, box };
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
  // New artwork for the first card: a new image tag, resampled; the old colour never lingers.
  h.document.querySelector(`[data-id="${ID}"] img`).src = img(ID, 't2');
  h.P.track(h.document.querySelector(`[data-id="${ID}"] .je-tag-host`));
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
  h.window.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms >= 1000 ? 0 : ms, ...rest);
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
  const rules = css.split('\n').map(line => ({ selector: line.slice(0, line.indexOf(' {')), line }));
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
  assert.match(css, /\[data-je-poster-colour\] \.quality-overlay-container\.quality-overlay-container \.quality-overlay-label \{ background: var\(--je-tag-bg\) !important; color: var\(--je-tag-fg\) !important; border-color: var\(--je-tag-border\) !important; \}/);
  assert.match(css, /\[data-je-poster-colour\] \.je-tag-pill \{ background: var\(--je-tag-bg\);/, 'the summary pill follows the artwork too');
  assert.doesNotMatch(css, /\[data-je-poster-colour\][^{]*language/, 'flags keep their look');
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
  h.window.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms >= 1000 ? 0 : ms, ...rest);
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
  h.window.setTimeout = (fn, ms, ...rest) => (ms >= 1000 ? (timers.push(fn), timers.length) : realTimeout(fn, ms, ...rest));
  h.P.setActive(true);
  await h.settle();
  assert.equal(timers.length, 1, "A's colour waits to be written");
  user = 'B';
  reset({ userId: 'B', previousUserId: 'A' });
  timers[0]();
  assert.deepEqual(puts, []);
});
