import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

// The blurred backdrop of status tags without backdrop-filter (tags/status-tag-backdrop.js,
// asked for by tags/statustags.js when the first status tag is drawn): the blur itself against pixels captured from Chromium,
// the geometry and CSS helpers, and the life of a card's pictures (drawn once its
// artwork is there, placed on the slot, redrawn only when the
// geometry changes, never drawn when the artwork cannot be shown faithfully).

/**
 * Noise behind a 14×9 `backdrop-filter: blur(6px)` box and what Chromium
 * 145 painted in it (software compositing, device scale 1): RGB, row by row.
 */
const GOLDEN = {
  width: 14, height: 9,
  before: 'yZpBlhrFAfjZII9zCWIOxNRPdBkv4Klf4LsBH/8e3cHG3ZJ4MZ87g9Xdqszw6sgKm2P4Hi993Ot2ZEcRckdPjFAAn9DGORJii0iNoZW2c240YUrCA/KRtIZf09XJUNBEJ6CG/JscImXObqeh9jhUiw+aAwO9C99PjKmHfjVME8URUEO+rjmBZo0AOINOYJDff7HzvyMWjTiaPdmc3UJinVi4Q/UzCMiSaE9qKyCHJRtbgmh0pWm8q5MsatsjyY3HwsT551MV+GGRLNioF1epH4qwKRhXAqVdImT+k/JsGs/8yI53QyMUeVv0NSDAYlKGE8ajlHJsTSlAlZ5IZGchMDRgWQSrB6Y1JzxqpQrfl5Wo90G7IbV7zDdhoa00ZSnoWIq75J1fabrhtuHGJp/cpi194AY94nZeg+6/OkW4IYGxLbEtKIL/eXppE8GHV2H/HK65SHG6QgYcbV4GQh5I1+mGx8Yz477vndsA4bqzLLzAVwkiZdd2suHO',
  after: 'cX98cYB8coB8c4B8c4B9dIB9dYF+dYF+doJ/d4J/d4OAd4OAd4OBd4OBcX98cX98cn98c4B9c4B9dIB9dIF+dYF+doJ/doKAd4OAd4OBd4OBd4OBcX98cX99cn99coB9c4B9dIB+dIF+dYF/doJ/doKAdoOBd4OBd4OBd4SBcX58cX99cn99cn99c4B+c4B+dIF/dYF/dYKAdoKAdoOBdoOBd4SCd4SCcH59cH59cX5+cn9+cn9+c4B/dIB/dYGAdYKAdoKBdoOCdoOCdoSCd4SCcH19cH5+cX5+cX9+cn9/c39/dICAdIGAdYKBdoKCdoOCdoODdoSDdoSDb31+cH1+cH1+cX5/cn5/c3+Ac4CAdIGBdYGBdYKCdoODdoODdoSEdoSDb3x+b31+cH1/cX5/cX5/cn+Ac4CAdIGBdIGCdYKCdYODdoOEdoSEdoSEb3x+b3x+cH1/cX5/cX5/cn+Ac3+BdICBdIGCdYKDdYODdoOEdoSEdoSE',
};

const ART = 'http://jellyfin.test/Items/a/Images/Primary?fillHeight=600&fillWidth=400&quality=96&tag=t1';
const GRADIENT = 'linear-gradient(rgba(0, 0, 0, 0.62), rgba(0, 0, 0, 0))';
const card = (art = ART) => `<div class="card" data-id="a"><div class="cardBox"><div class="cardScalable">`
  + `<a class="cardImageContainer"${art ? ` style="background-image: url('${art}')"` : ''}></a>`
  + `<div class="je-tag-host"><div class="je-tag-slot" data-je-slot="tr"><div class="status-overlay-container" data-je-group="status">`
  + `<div class="status-tag" data-je-status="new">New</div></div></div></div></div></div></div>`;

/** Computed values a real browser reports for an element nothing styles. */
const DEFAULT_STYLE = {
  backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', backgroundSize: 'auto', backgroundPosition: '0% 0%', backgroundRepeat: 'repeat',
  backgroundOrigin: 'padding-box', backgroundClip: 'border-box', backgroundAttachment: 'scroll', filter: 'none', visibility: 'visible', opacity: '1',
  contain: 'none', containerType: 'normal', willChange: 'auto', contentVisibility: 'visible', transform: 'none',
  borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
  borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px',
  objectFit: 'fill', objectPosition: '50% 50%',
};
const WRITTEN = { 'background-image': 'backgroundImage', 'background-position': 'backgroundPosition', 'background-size': 'backgroundSize', 'background-repeat': 'backgroundRepeat' };

/**
 * The status module in a page whose layout, styles, images, canvas and timers
 * the test owns: `rect(el, …)` and `style(el, …)` say where an element is and
 * what it computes to, `flush()` runs frames, timers and promises until none
 * is left, and `layers(el)` is what was written to an element's background.
 */
function setup(t, { html = card(), scene = () => [200, 120, 40, 255], trending = [], painter = true, loader = null } = {}) {
  const renderers = new Map();
  const h = createHarness({
    html,
    JE: {
      currentSettings: { statusTagsEnabled: true },
      pluginConfig: { StatusTagsEnabled: true, TagCacheServerMode: false },
      t: key => key,
      session: { getUserId: () => 'a', getServerId: () => 's', onUserChange(name, fn) { if (name === 'status-tag-backdrop') h.userChanged = fn; } },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name), clearProcessed() {}, scheduleScan() {} },
    },
    apiClient: { ajax: async () => trending.shift() },
  });
  h.renderers = renderers;
  t.after(() => h.close());
  const w = h.window;

  // Frames and timers run by hand.
  const queue = [];
  w.requestAnimationFrame = fn => queue.push(fn);
  w.setTimeout = fn => queue.push(fn);
  w.clearTimeout = () => {};
  const tick = () => new Promise(resolve => setImmediate(resolve));
  h.flush = async () => {
    for (let i = 0; i < 200; i++) {
      await tick();
      if (!queue.length) { await tick(); if (!queue.length) return; }
      for (const fn of queue.splice(0)) fn();
    }
    throw new Error('the page never settled');
  };
  /** One frame: what is queued now, nothing it queues. */
  h.frame = async () => { await tick(); for (const fn of queue.splice(0)) fn(); await tick(); };

  // Layout and computed style.
  const rects = new Map();
  const styles = new Map();
  const written = new Map();
  h.rect = (el, left, top, right, bottom) => rects.set(el, { left, top, right, bottom, width: right - left, height: bottom - top });
  h.style = (el, values) => styles.set(el, { ...(styles.get(el) || {}), ...values });
  w.Element.prototype.getBoundingClientRect = function () { return rects.get(this) || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
  const set = w.CSSStyleDeclaration.prototype.setProperty, remove = w.CSSStyleDeclaration.prototype.removeProperty;
  w.CSSStyleDeclaration.prototype.setProperty = function (name, value, ...rest) {
    if (WRITTEN[name]) { if (!written.has(this)) written.set(this, {}); written.get(this)[name] = value; }
    return set.call(this, name, value, ...rest);
  };
  w.CSSStyleDeclaration.prototype.removeProperty = function (name) {
    if (written.has(this)) delete written.get(this)[name];
    return remove.call(this, name);
  };
  w.getComputedStyle = el => {
    const out = { ...DEFAULT_STYLE, ...(styles.get(el) || {}) };
    const inline = el.style.backgroundImage;
    if (inline && !written.get(el.style)?.['background-image']) out.backgroundImage = inline.replace(/'/g, '"');
    for (const [name, key] of Object.entries(WRITTEN)) if (written.get(el.style)?.[name]) out[key] = written.get(el.style)[name];
    return out;
  };
  h.layers = el => ({ ...(written.get(el.style) || {}) });

  // Images, bitmaps and the canvas.
  const natural = { width: 400, height: 600 };
  Object.defineProperty(w.HTMLImageElement.prototype, 'complete', { configurable: true, get() { return true; } });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get() { return natural.width; } });
  Object.defineProperty(w.HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get() { return natural.height; } });
  w.HTMLImageElement.prototype.decode = async function () {};
  h.decoded = [];
  h.closed = [];
  w.createImageBitmap = async source => { h.decoded.push(source.src); const bitmap = { url: source.src, close() { h.closed.push(source.src); } }; return bitmap; };
  h.ops = [];
  h.blurred = [];
  h.scene = scene;
  h.readError = null;
  /** A canvas that answers with other pixels than were drawn, without throwing. */
  h.lying = false;
  let pictures = 0;
  const contexts = new WeakMap();
  w.HTMLCanvasElement.prototype.getContext = function () {
    if (!contexts.has(this)) {
      const canvas = this;
      contexts.set(this, {
        clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {}, save() {}, restore() {}, clip() {},
        translate(...args) { h.ops.push(['translate', ...args.map(Math.round)]); },
        stroke() { h.ops.push(['stroke', this.strokeStyle, this.lineWidth]); },
        fillText(text, x, y) { h.ops.push(['fillText', text, this.font, this.fillStyle, Math.round(x), Math.round(y)]); },
        fillRect(...args) {
          // The 2×2 canvas is the painter's probe (isSupported): it reads back the colour it drew.
          if (canvas.width === 2 && canvas.height === 2) { this.probe = /\d+/g[Symbol.match](this.fillStyle).map(Number); return; }
          h.ops.push(['fillRect', this.fillStyle, ...args]);
        },
        fill() { h.ops.push(['fill', this.globalCompositeOperation, ...(this.globalCompositeOperation === 'destination-in' ? [] : [this.fillStyle])]); },
        drawImage(source, ...args) { h.ops.push(['drawImage', source.url || 'canvas', ...args]); },
        createLinearGradient(...args) { const stops = []; return { gradient: args, stops, addColorStop: (at, colour) => stops.push([at, colour]) }; },
        getImageData(x, y, width, height) {
          if (this.probe && !h.lying) return { data: Uint8ClampedArray.from([...this.probe, 255]), width, height };
          if (h.readError) throw h.readError;
          const data = new Uint8ClampedArray(width * height * 4);
          for (let i = 0; i < width * height; i++) data.set(h.scene(i % width, Math.floor(i / width)), i * 4);
          return { data, width, height };
        },
        putImageData(image) { h.blurred.push({ width: canvas.width, height: canvas.height, data: Array.from(image.data.slice(0, 4)) }); },
      });
    }
    return contexts.get(this);
  };
  w.HTMLCanvasElement.prototype.toDataURL = function () { return `data:image/png;base64,PIC${++pictures}w${this.width}h${this.height}`; };

  h.load('core/ui-kit.js');
  h.load('core/tag-renderer-base.js');
  h.load('tags/status-vocabulary.js');
  if (loader) h.JE.loader = loader;
  h.load('tags/statustags.js');
  // The painter is a file of its own (a component group fetched on demand); `arrive()` is that file running.
  h.arrive = () => { h.load('tags/status-tag-backdrop.js'); h.backdrop = h.JE.statusTagBackdrop; };
  if (painter) h.arrive();
  const $ = selector => h.document.querySelector(selector);
  Object.assign(h, { root: $('.cardScalable'), art: $('.cardImageContainer'), host: $('.je-tag-host'), slot: $('.je-tag-slot'), group: $('.status-overlay-container'), tag: $('.status-tag') });
  return h;
}

/**
 * A 200×300 poster at a fractional place on the page, inside Jellyfin's
 * `contain: layout style` card box; its slot is inset by 6px and the tag
 * (77.6 × 21.8) sits at the slot's top right.
 */
function layout(h, { tagLeft = 216.8, tagTop = 56.3, tagWidth = 77.6, slotRight = 294.4 } = {}) {
  h.style(h.root, { contain: 'layout style' });
  h.rect(h.root, 100.4, 50.3, 300.4, 350.3);
  h.rect(h.art, 100.4, 50.3, 300.4, 350.3);
  h.rect(h.host, 100.4, 50.3, 300.4, 350.3);
  h.style(h.art, { backgroundSize: 'cover', backgroundPosition: '50% 50%', backgroundRepeat: 'no-repeat' });
  h.rect(h.slot, 106.4, 56.3, slotRight, 344.3);
  h.rect(h.group, tagLeft, tagTop, tagLeft + tagWidth, tagTop + 21.8);
  h.rect(h.tag, tagLeft, tagTop, tagLeft + tagWidth, tagTop + 21.8);
  h.style(h.tag, { backgroundColor: 'rgba(15, 15, 15, 0.72)', borderTopLeftRadius: '6px', borderTopRightRadius: '6px', borderBottomRightRadius: '6px', borderBottomLeftRadius: '6px' });
}

const rgb = base64 => Uint8Array.from(Buffer.from(base64, 'base64'));
/** RGB triples as opaque RGBA. */
function rgba(values) {
  const out = new Uint8ClampedArray(values.length / 3 * 4);
  for (let i = 0; i < values.length / 3; i++) out.set([values[i * 3], values[i * 3 + 1], values[i * 3 + 2], 255], i * 4);
  return out;
}

/** The blur written the slow way: every pixel summed over its mirrored neighbours, one direction at a time. */
function reference(data, width, height, sigma, sizes) {
  const kernel = sizes.reduce((acc, size) => { const out = new Array(acc.length + size - 1).fill(0); acc.forEach((v, i) => { for (let k = 0; k < size; k++) out[i + k] += v / size; }); return out; }, [1]);
  const reach = (kernel.length - 1) / 2;
  const mirror = (i, n) => { let j = ((i % (2 * n)) + 2 * n) % (2 * n); return j >= n ? 2 * n - 1 - j : j; };
  const pass = (src, horizontal) => {
    const out = Float64Array.from(src);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -reach; k <= reach; k++) {
        const xx = horizontal ? mirror(x + k, width) : x, yy = horizontal ? y : mirror(y + k, height);
        sum += src[(yy * width + xx) * 4 + c] * kernel[k + reach];
      }
      out[(y * width + x) * 4 + c] = Math.floor(sum + 0.5);
    }
    return out;
  };
  return pass(pass(Float64Array.from(data), true), false);
}

test('the blur is Chromium\'s backdrop blur: the same pixels, bit for bit', async t => {
  const h = setup(t);
  const { backdrop } = h;
  // Values made in the page's realm, compared as plain data.
  const pure = new Proxy({}, { get: (_, name) => (...args) => plain(backdrop[name](...args)) });
  assert.deepEqual(pure.boxSizes(6), [11, 11, 11], 'sigma 6: three boxes of floor(6 × 3 × sqrt(2π) / 4 + 0.5)');
  assert.deepEqual(pure.boxSizes(12), [23, 23, 23]);
  assert.deepEqual(pure.boxSizes(7.5), [14, 14, 15], 'an even width: the third box is a pixel wider');
  assert.deepEqual(pure.boxSizes(0.3), [], 'too small to change anything');

  const before = rgba(rgb(GOLDEN.before)), after = rgb(GOLDEN.after);
  const blurred = backdrop.blurRgba(Uint8ClampedArray.from(before), GOLDEN.width, GOLDEN.height, 6);
  assert.deepEqual(Array.from(blurred).filter((_, i) => i % 4 !== 3), Array.from(after), 'a box smaller than the kernel, mirrored more than once');
  assert.ok(Array.from(blurred).every((v, i) => i % 4 !== 3 || v === 255), 'alpha is left alone');

  // Any size, even and odd box widths, against the slow reference.
  let seed = 99;
  const noise = (width, height) => { const data = new Uint8ClampedArray(width * height * 4); for (let i = 0; i < data.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; data[i] = i % 4 === 3 ? 255 : (seed >> 16) & 255; } return data; };
  for (const [width, height, sigma] of [[40, 22, 6], [9, 31, 6], [25, 12, 7.5], [3, 2, 12]]) {
    const data = noise(width, height);
    const want = reference(data, width, height, sigma, backdrop.boxSizes(sigma));
    assert.deepEqual(Array.from(backdrop.blurRgba(Uint8ClampedArray.from(data), width, height, sigma)), Array.from(want), `${width}×${height} at sigma ${sigma}`);
  }
  const flat = new Uint8ClampedArray(20 * 10 * 4).fill(77);
  assert.ok(backdrop.blurRgba(flat, 20, 10, 6).every(v => v === 77), 'a flat colour stays that colour');
  const tiny = Uint8ClampedArray.from([1, 2, 3, 255]);
  assert.deepEqual(Array.from(backdrop.blurRgba(tiny, 1, 1, 0.3)), [1, 2, 3, 255]);
});

test('CSS values and geometry: layers, colours, gradients, image placement, pixel grids', async t => {
  const h = setup(t);
  const { backdrop } = h;
  // Values made in the page's realm, compared as plain data.
  const pure = new Proxy({}, { get: (_, name) => (...args) => plain(backdrop[name](...args)) });
  assert.deepEqual(pure.splitLayers(`url("a,b"), ${GRADIENT}, none`), ['url("a,b")', GRADIENT, 'none']);
  assert.deepEqual(pure.splitLayers(''), []);
  assert.deepEqual(pure.parseColour('rgba(15, 15, 15, 0.72)'), [15, 15, 15, 0.72]);
  assert.deepEqual(pure.parseColour('rgb(1, 2, 3)'), [1, 2, 3, 1]);
  assert.deepEqual(pure.parseColour('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5]);
  assert.deepEqual(pure.parseColour('transparent'), [0, 0, 0, 0]);
  assert.equal(backdrop.parseColour('color(display-p3 1 0 0)'), null);

  assert.deepEqual(pure.parseGradient(GRADIENT), { angle: 180, stops: [{ colour: 'rgba(0, 0, 0, 0.62)', at: 0 }, { colour: 'rgba(0, 0, 0, 0)', at: 1 }] }, 'top to bottom unless it says otherwise');
  assert.deepEqual(pure.parseGradient('linear-gradient(to top, rgba(0, 0, 0, 0.86), rgba(0, 0, 0, 0.55) 62%, rgba(0, 0, 0, 0))'),
    { angle: 0, stops: [{ colour: 'rgba(0, 0, 0, 0.86)', at: 0 }, { colour: 'rgba(0, 0, 0, 0.55)', at: 0.62 }, { colour: 'rgba(0, 0, 0, 0)', at: 1 }] });
  assert.deepEqual(pure.parseGradient('linear-gradient(45deg, rgb(1, 1, 1), rgb(2, 2, 2), rgb(3, 3, 3), rgb(4, 4, 4) 90%, rgb(5, 5, 5))').stops.map(s => s.at), [0, 0.3, 0.6, 0.9, 1], 'unplaced stops are spread evenly');
  for (const unknown of ['radial-gradient(rgb(0, 0, 0), rgb(1, 1, 1))', 'linear-gradient(to top left, rgb(0, 0, 0), rgb(1, 1, 1))', 'linear-gradient(rgb(0, 0, 0) 10px, rgb(1, 1, 1))', 'linear-gradient(in oklab, rgb(0, 0, 0), rgb(1, 1, 1))', 'url("x.png")']) {
    assert.equal(backdrop.parseGradient(unknown), null, unknown);
  }

  assert.deepEqual(pure.fitImage(400, 600, 200, 300, { size: 'cover', position: '50% 50%' }, 1), { x: 0, y: 0, width: 200, height: 300 });
  assert.deepEqual(pure.fitImage(400, 400, 200, 300, { size: 'cover', position: '50% 50%' }, 1), { x: -50, y: 0, width: 300, height: 300 }, 'cover crops the sides');
  assert.deepEqual(pure.fitImage(400, 400, 200, 300, { size: 'contain', position: '50% 0%' }, 1), { x: 0, y: 0, width: 200, height: 200 });
  assert.deepEqual(pure.fitImage(400, 400, 200, 300, { size: 'fill', position: '50% 50%' }, 1), { x: 0, y: 0, width: 200, height: 300 });
  assert.deepEqual(pure.fitImage(100, 50, 200, 300, { size: 'auto', position: '10px 20px' }, 2), { x: 20, y: 40, width: 200, height: 100 }, 'CSS pixels become device pixels');
  assert.deepEqual(pure.fitImage(100, 50, 200, 300, { size: '50% auto', position: '100% 100%' }, 1), { x: 100, y: 250, width: 100, height: 50 });
  assert.equal(backdrop.fitImage(100, 50, 200, 300, { size: 'calc(10px + 5%) auto', position: '0% 0%' }, 1), null);
  assert.equal(backdrop.fitImage(0, 0, 200, 300, { size: 'cover', position: '50% 50%' }, 1), null);

  assert.equal(backdrop.snap(10.5), 11);
  assert.equal(backdrop.snap(10.49), 10);
  // Measured on Chromium 145 (see the module's comment).
  const grid = (style, moves = false) => backdrop.startsPixelGrid({ ...DEFAULT_STYLE, ...style }, moves);
  for (const own of [{ contain: 'layout style' }, { contain: 'content' }, { contain: 'strict' }, { contain: 'paint' }, { contain: 'size layout style' },
    { contain: 'layout', containerType: 'inline-size' }, { willChange: 'transform' }, { willChange: 'scale' }, { contentVisibility: 'auto' }, { transform: 'matrix(1.1, 0, 0, 1.1, 0, 0)' }]) {
    assert.equal(grid(own), true, JSON.stringify(own));
  }
  for (const page of [{}, { contain: 'layout' }, { contain: 'style' }, { contain: 'size' }, { containerType: 'inline-size' }, { willChange: 'opacity' }, { willChange: 'translate' }]) {
    assert.equal(grid(page), false, JSON.stringify(page));
  }
  assert.equal(grid({ transform: 'matrix(1, 0, 0, 1, -200, 0)' }, true), false, 'a plain move keeps the page\'s grid');

  // A layer inside its carrier is given as it is; one the carrier's unsnapped box would cut is given the part inside.
  assert.deepEqual(pure.placeLayer(116, 194, 6, 194), { offset: 110, size: 78 });
  assert.deepEqual(pure.placeLayer(116, 194, 6.25, 193.75), { offset: 109.75, size: 77.75 }, 'ends on the carrier\'s edge, snaps to the same pixels');
  assert.deepEqual(pure.placeLayer(6, 28, 6.4, 300), { offset: 0, size: 21.6 });
  assert.equal(backdrop.placeLayer(116, 195, 6, 194.2), null, 'the carrier cannot show the last pixel');
  assert.equal(backdrop.placeLayer(10, 10, 0, 100), null);
});

test('a tag gets its picture once the card is laid out: the artwork under it, blurred, on the slot', async t => {
  const h = setup(t);
  layout(h);
  h.backdrop.track(h.host);
  assert.deepEqual(h.layers(h.slot), {}, 'nothing before the next paint: the tag shows with the plain pill');
  await h.flush();

  assert.deepEqual(h.decoded, [ART], 'the artwork the card shows, decoded once');
  // Everything is snapped from the card box's own corner (100.4, 50.3): the tag is at 116.4 → 116, 6;
  // 77.6 × 21.8 rounds to 78 × 22; the artwork fills the box from -116, -6.
  assert.deepEqual(h.ops.find(op => op[0] === 'drawImage'), ['drawImage', ART, -116, -6, 200, 300]);
  assert.deepEqual(h.blurred, [{ width: 78, height: 22, data: [200, 120, 40, 255] }], 'read back, blurred and put back');
  assert.deepEqual(h.ops.at(-1), ['fill', 'destination-in'], 'the rounded corners are cut out');
  assert.deepEqual(h.layers(h.slot), {
    'background-image': 'url("data:image/png;base64,PIC2w78h22")',
    'background-position': '110px 0px',
    'background-size': '78px 22px',
    'background-repeat': 'no-repeat',
  });
  assert.deepEqual(h.layers(h.host), {});
  assert.deepEqual(h.layers(h.group), {}, 'the group and the tag are left alone');
  assert.equal(h.tag.getAttribute('style'), null);
  assert.equal(h.host.querySelectorAll('*').length, 3, 'no element is added');
  const stats = h.backdrop.stats();
  assert.deepEqual([stats.watching, stats.drawn, stats.plain, stats.failed, stats.waiting, stats.decoding], [1, 1, 0, 0, 0, 0]);
});

test('a picture stops at its slot\'s box: a column the filter reached past it is left out', async t => {
  const h = setup(t);
  // Left 116.6 → 117 and width 77.6 → 78 end at 195; the slot's box ends at 194.2 → 194.
  layout(h, { tagLeft: 217, slotRight: 294.6 });
  h.backdrop.track(h.host);
  await h.flush();
  assert.deepEqual(h.blurred.map(b => [b.width, b.height]), [[78, 22]], 'blurred over the filter\'s whole box');
  assert.deepEqual(h.layers(h.slot), {
    'background-image': 'url("data:image/png;base64,PIC2w77h22")',
    'background-position': '111px 0px',
    'background-size': '77px 22px',
    'background-repeat': 'no-repeat',
  }, 'the part inside the slot, pixel for pixel');
  assert.deepEqual(h.ops.filter(op => op[0] === 'drawImage' && op[1] === 'canvas'), [['drawImage', 'canvas', 0, 0, 77, 22, 0, 0, 77, 22]]);
  assert.deepEqual(h.layers(h.host), {}, 'nothing on the host: it would stay behind when the slot fades alone');
});

test('a group that starts a pixel grid of its own snaps its tag from its own corner', async t => {
  const h = setup(t);
  // The group is at 116.4, 6 in the card and the tag 0.3px inside it: 116 + 0, not round(116.7) = 117.
  layout(h, { tagLeft: 217.1 });
  h.rect(h.group, 216.8, 56.3, 294.7, 78.1);
  h.style(h.group, { contain: 'layout style' });
  h.backdrop.track(h.host);
  await h.flush();
  assert.deepEqual(h.ops.find(op => op[0] === 'drawImage'), ['drawImage', ART, -116, -6, 200, 300]);
  assert.equal(h.layers(h.slot)['background-position'], '110px 0px');
});

test('a card is drawn again only when its geometry changed; a tag that moved loses its old picture after the next paint', async t => {
  const h = setup(t);
  layout(h);
  h.backdrop.track(h.host);
  await h.flush();
  const first = h.layers(h.slot);

  // Another chip changes, nothing moves: no new picture.
  const chip = h.document.createElement('div');
  h.host.querySelector('.je-tag-slot').appendChild(chip);
  chip.setAttribute('data-je-overflow', '');
  await h.flush();
  assert.deepEqual(h.layers(h.slot), first);
  assert.equal(h.backdrop.stats().drawn, 1);

  // A group arrives above the tag and pushes it down.
  layout(h, { tagTop: 86.3 });
  chip.textContent = 'Drama';
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.layers(h.slot), first, 'no layout is read in the middle of the change');
  await h.frame(); await h.frame();
  assert.deepEqual(h.layers(h.slot), {}, 'gone in the measuring pass after the paint');
  await h.flush();
  assert.equal(h.layers(h.slot)['background-position'], '110px 30px');
  assert.deepEqual(h.ops.filter(op => op[0] === 'drawImage').at(-1), ['drawImage', ART, -116, -36, 200, 300]);
  assert.deepEqual(h.decoded, [ART], 'the decoded artwork is used again');
  assert.equal(h.backdrop.stats().drawn, 2);

  // The tag goes: so does its picture, and nothing is drawn.
  h.group.remove();
  await h.flush();
  assert.deepEqual(h.layers(h.slot), {});
  assert.equal(h.backdrop.stats().drawn, 2);
});

test('a band the slot paints is blurred into the picture and stays under it', async t => {
  const h = setup(t);
  layout(h);
  h.style(h.slot, { backgroundImage: GRADIENT });
  h.backdrop.track(h.host);
  await h.flush();
  const band = h.ops.find(op => op[0] === 'fillRect' && op[1]?.gradient);
  assert.ok(band, 'the gradient is painted over the artwork before the blur');
  // The slot's box, seen from the picture's corner (the slot starts 110px left of the tag, at its top).
  assert.deepEqual(band.slice(2), [-110, 0, 188, 288]);
  assert.deepEqual(band[1].gradient.map(Math.round), [-16, 0, -16, 288], 'top to bottom, down the slot');
  assert.deepEqual(band[1].stops, [[0, 'rgba(0, 0, 0, 0.62)'], [1, 'rgba(0, 0, 0, 0)']]);
  assert.deepEqual(h.layers(h.slot), {
    'background-image': `url("data:image/png;base64,PIC2w78h22"), ${GRADIENT}`,
    'background-position': '110px 0px, 0% 0%',
    'background-size': '78px 22px, auto',
    'background-repeat': 'no-repeat, repeat',
  });
  // Measured again, the slot's own layer is still only the band.
  h.tag.setAttribute('title', 'x');
  await h.flush();
  assert.equal(h.backdrop.stats().drawn, 1);
  assert.equal(h.layers(h.slot)['background-image'], `url("data:image/png;base64,PIC2w78h22"), ${GRADIENT}`);

  // A background this module cannot draw: the plain pill.
  const other = setup(t);
  layout(other);
  other.style(other.slot, { backgroundImage: 'url("pattern.png")' });
  other.backdrop.track(other.host);
  await other.flush();
  assert.deepEqual(other.layers(other.slot), {});
  assert.equal(other.decoded.length, 0);
});

test('a chip of an earlier slot that reaches under the tag is blurred into the picture', async t => {
  const chips = '<div class="je-tag-slot" data-je-slot="tl"><div class="quality-overlay-container" data-je-group="quality">'
    + '<div class="quality-overlay-label" id="long">Dolby Digital+ 7.1</div><div class="quality-overlay-label" id="short">4K</div><img id="flag" src="http://jellyfin.test/JellyfinEnhanced/cdn/flags/gb.svg"><img id="far" src="http://cdn.example/x.png"></div></div>';
  const h = setup(t, { html: card().replace('<div class="je-tag-slot" data-je-slot="tr">', `${chips}<div class="je-tag-slot" data-je-slot="tr">`) });
  h.slot = h.document.querySelector('[data-je-slot="tr"]');
  layout(h);
  const tl = h.document.querySelector('[data-je-slot="tl"]');
  h.rect(tl, 106.4, 56.3, 294.4, 344.3);
  // A long label that ends 20px inside the tag's box (the tag starts at 216.4), a short one that does not reach it.
  const long = h.document.getElementById('long'), short = h.document.getElementById('short');
  h.rect(long, 110.4, 58.3, 236.4, 76.3);
  h.style(long, { backgroundColor: 'rgb(0, 150, 136)', borderTopLeftRadius: '4px', borderTopWidth: '1px', borderTopColor: 'rgba(255, 255, 255, 0.3)', color: 'rgb(255, 255, 255)', fontStyle: 'normal', fontWeight: '700', fontSize: '12px', fontFamily: 'Noto Sans', letterSpacing: 'normal', textTransform: 'uppercase' });
  h.rect(short, 110.4, 80.3, 140.4, 98.3);
  h.style(short, { backgroundColor: 'rgb(30, 136, 229)' });
  // Images under the tag: the same-origin one is drawn, the other would taint the canvas.
  h.rect(h.document.getElementById('flag'), 220.4, 60.3, 236.4, 72.3);
  h.rect(h.document.getElementById('far'), 240.4, 60.3, 256.4, 72.3);
  h.window.document.createRange = () => ({ selectNodeContents() {}, getBoundingClientRect: () => ({ left: 114.4, top: 60.3, right: 232.4, bottom: 74.3, width: 118, height: 14 }) });
  h.backdrop.track(h.host);
  await h.flush();
  const scene = h.ops.slice(h.ops.findIndex(op => op[0] === 'drawImage'), h.ops.findIndex(op => op[0] === 'fill' && op[1] === 'destination-in'));
  assert.deepEqual(scene, [
    ['drawImage', ART, -116, -6, 200, 300],
    // The label's box, 106px left of the tag's corner and 2px below it, its border inside the edge.
    ['translate', -106, 2], ['fill', 'source-over', 'rgb(0, 150, 136)'], ['stroke', 'rgba(255, 255, 255, 0.3)', 2],
    ['fillText', 'DOLBY DIGITAL+ 7.1', 'normal 700 12px Noto Sans', 'rgb(255, 255, 255)', -102, 11],
    ['drawImage', 'canvas', 4, 4, 16, 12],
  ], 'the artwork, then the chip that lies under the tag: box, border, label, flag');
  assert.equal(h.layers(h.slot)['background-size'], '78px 22px');

  // The chip changes colour: the card is drawn again.
  h.style(long, { backgroundColor: 'rgb(200, 0, 0)' });
  long.setAttribute('data-quality', 'x');
  await h.flush();
  assert.equal(h.backdrop.stats().drawn, 2);
  // Both slots fade together (the pointer hides the tags): nothing to draw again.
  h.style(tl, { opacity: '0' });
  h.style(h.slot, { opacity: '0' });
  long.setAttribute('data-quality', 'y');
  await h.flush();
  assert.equal(h.backdrop.stats().drawn, 2);
  // A slot that does not show while the tag's does (a summary giving way to the reveal) is not under it.
  h.style(h.slot, { opacity: '1' });
  long.setAttribute('data-quality', 'z');
  await h.flush();
  assert.equal(h.backdrop.stats().drawn, 3);
  assert.equal(h.ops.filter(op => op[0] === 'fillText').length, 2, 'its label is not drawn into the third picture');
});

test('artwork that is not there yet gets its picture when it arrives', async t => {
  const h = setup(t, { html: card('') });
  layout(h);
  h.backdrop.track(h.host);
  await h.flush();
  assert.deepEqual(h.layers(h.slot), {});
  assert.equal(h.decoded.length, 0);
  h.art.style.backgroundImage = `url('${ART}')`;
  await h.flush();
  assert.deepEqual(h.decoded, [ART]);
  assert.equal(h.layers(h.slot)['background-size'], '78px 22px');
});

test('a card presented again in place gets its pictures on the new slot, without drawing them again', async t => {
  const h = setup(t);
  layout(h);
  h.backdrop.track(h.host);
  await h.flush();
  const first = h.layers(h.slot);
  assert.ok(first['background-image']);
  // The layout controller re-presents the card (a settings change): the same chips in a new slot, at the same place.
  const slot = h.slot.cloneNode(true);
  slot.removeAttribute('style');
  h.rect(slot, 106.4, 56.3, 294.4, 344.3);
  const group = slot.querySelector('.status-overlay-container'), tag = slot.querySelector('.status-tag');
  h.rect(group, 216.8, 56.3, 294.4, 78.1);
  h.rect(tag, 216.8, 56.3, 294.4, 78.1);
  h.style(tag, { backgroundColor: 'rgba(15, 15, 15, 0.72)', borderTopLeftRadius: '6px', borderTopRightRadius: '6px', borderBottomRightRadius: '6px', borderBottomLeftRadius: '6px' });
  h.slot.replaceWith(slot);
  await h.flush();
  assert.deepEqual(h.layers(slot), first, 'the pictures the card already has, on the slot it has now');
  const stats = h.backdrop.stats();
  assert.deepEqual([stats.drawn, stats.decodes], [1, 1], 'nothing decoded or drawn again');
});

test('artwork the lazy loader parks while a card is out of view leaves its pictures alone: nothing is measured or written as a row scrolls', async t => {
  const h = setup(t);
  layout(h);
  h.backdrop.track(h.host);
  await h.flush();
  const first = h.layers(h.slot);
  const before = h.backdrop.stats();
  // Jellyfin's unload: the background image goes and its address is parked in data-src…
  h.art.style.backgroundImage = 'none';
  h.art.setAttribute('data-src', ART);
  await h.flush();
  assert.deepEqual(h.layers(h.slot), first, 'the pictures stay for when the card is seen again');
  // … and the same image comes back when the card returns.
  h.art.style.backgroundImage = `url('${ART}')`;
  h.art.removeAttribute('data-src');
  await h.flush();
  assert.deepEqual(h.layers(h.slot), first);
  const after = h.backdrop.stats();
  assert.deepEqual([after.measures, after.drawn, after.decodes], [before.measures, before.drawn, before.decodes], 'no measuring pass, nothing drawn');
  // Other artwork parked or shown is a change like any other.
  h.art.style.backgroundImage = 'none';
  h.art.setAttribute('data-src', ART.replace('t1', 't2'));
  await h.flush();
  assert.deepEqual(h.layers(h.slot), {}, 'pictures of other artwork do not stay');
});

test('the layout controller\'s marks on the host are not a move: no measuring pass', async t => {
  const h = setup(t);
  layout(h);
  h.backdrop.track(h.host);
  await h.flush();
  const before = h.backdrop.stats().measures;
  for (const mark of ['data-je-flow', 'data-je-live']) { h.host.setAttribute(mark, '1'); await h.flush(); h.host.removeAttribute(mark); await h.flush(); }
  assert.equal(h.backdrop.stats().measures, before);
  // Anything else on the host still is.
  h.host.setAttribute('data-je-layout', 'bands');
  await h.flush();
  assert.equal(h.backdrop.stats().measures, before + 1);
});

test('artwork that Jellyfin unloads and loads again shows the pictures the card already has', async t => {
  const h = setup(t);
  layout(h);
  h.backdrop.track(h.host);
  await h.flush();
  const first = h.layers(h.slot);
  // The card is scrolled out of its row: the lazy loader takes the image away…
  h.art.style.backgroundImage = 'none';
  await h.flush();
  assert.deepEqual(h.layers(h.slot), {}, 'no picture without artwork');
  // … and puts it back when the card returns.
  h.art.style.backgroundImage = `url('${ART}')`;
  await h.flush();
  assert.deepEqual(h.layers(h.slot), first, 'the same picture');
  const stats = h.backdrop.stats();
  assert.deepEqual([stats.drawn, stats.decodes, stats.reused], [1, 1, 1], 'nothing decoded or drawn again');
  // Other artwork is drawn afresh.
  h.art.style.backgroundImage = `url('${ART.replace('t1', 't2')}')`;
  await h.flush();
  assert.equal(h.backdrop.stats().drawn, 2);
});

test('the plain pill is kept where the picture would not be what the page shows', async t => {
  const draw = async (prepare) => {
    const h = setup(t);
    layout(h);
    prepare(h);
    h.backdrop.track(h.host);
    await h.flush();
    return h;
  };
  // Artwork a style blurs, hides or fades is never sampled.
  for (const hidden of [{ filter: 'blur(20px)' }, { visibility: 'hidden' }, { opacity: '0.4' }]) {
    const h = await draw(h => h.style(h.art, hidden));
    assert.deepEqual(h.layers(h.slot), {}, JSON.stringify(hidden));
    assert.equal(h.decoded.length, 0, 'not even decoded');
  }
  // An opaque tag hides its backdrop; a tag reaching outside the artwork has something else behind it.
  assert.equal((await draw(h => h.style(h.tag, { backgroundColor: 'rgb(20, 20, 20)' }))).decoded.length, 0);
  assert.equal((await draw(h => h.rect(h.art, 100.4, 70.3, 300.4, 350.3))).decoded.length, 0);
  // Transparent pixels with nothing known behind them.
  const seeThrough = await draw(h => { h.scene = () => [200, 120, 40, 128]; });
  assert.deepEqual(seeThrough.layers(seeThrough.slot), {});
  assert.equal(seeThrough.backdrop.stats().plain, 1);
  // … unless the image box paints an opaque colour of its own under the image.
  const based = await draw(h => h.style(h.art, { backgroundColor: 'rgb(36, 36, 36)' }));
  assert.deepEqual(based.ops.find(op => op[0] === 'fillRect'), ['fillRect', 'rgb(36, 36, 36)', 0, 0, 78, 22]);
  assert.equal(based.layers(based.slot)['background-size'], '78px 22px');
});

test('a canvas the browser will not let us read: no picture, and that artwork is not tried again', async t => {
  const h = setup(t);
  layout(h);
  h.readError = Object.assign(new Error('tainted'), { name: 'SecurityError' });
  h.backdrop.track(h.host);
  await h.flush();
  assert.deepEqual(h.layers(h.slot), {});
  assert.deepEqual(h.closed, [ART], 'its bitmap is freed');
  const stats = h.backdrop.stats();
  assert.deepEqual([stats.failed, stats.unreadable, stats.artwork], [1, 1, 0]);
  h.readError = null;
  layout(h, { tagTop: 86.3 });
  h.tag.setAttribute('title', 'moved');
  await h.flush();
  assert.equal(h.decoded.length, 1);
  assert.deepEqual(h.layers(h.slot), {});
});

test('cards gone from the page are released, a user switch redraws, and off takes every picture away', async t => {
  const h = setup(t, { html: card() + card('http://jellyfin.test/Items/b/Images/Primary?tag=t2') });
  layout(h);
  h.backdrop.track(h.host);
  await h.flush();
  assert.equal(h.backdrop.stats().watching, 2, 'the painter took up both tags on the page when it started');

  // A user switch: the outgoing user's decoded artwork is dropped and the card is drawn again.
  h.userChanged();
  assert.deepEqual(h.closed, [ART]);
  await h.flush();
  assert.deepEqual(h.decoded, [ART, ART]);
  assert.equal(h.layers(h.slot)['background-size'], '78px 22px');

  // The first card leaves the page; the next badge drawn anywhere releases it.
  const second = h.document.querySelectorAll('.je-tag-host')[1];
  h.host.closest('.card').remove();
  h.backdrop.track(second);
  await h.flush();
  assert.equal(h.backdrop.stats().watching, 1);

  h.backdrop.track(h.host);
  assert.equal(h.backdrop.stats().watching, 2, 'tracked again when its badge is drawn again');
  h.backdrop.setActive(false);
  assert.equal(h.backdrop.isActive(), false);
  assert.equal(h.backdrop.stats().watching, 0);
  h.backdrop.track(second);
  assert.equal(h.backdrop.stats().watching, 0, 'off: nothing is tracked');
});

test('a page full of new cards is measured a few cards a frame', async t => {
  const h = setup(t, { html: Array.from({ length: 14 }, () => card()).join('') });
  // Every look at the clock takes 2 ms: the first batch of six uses up the pass's 3 ms.
  let now = 0;
  h.window.performance.now = () => (now += 2);
  for (const host of h.document.querySelectorAll('.je-tag-host')) h.backdrop.track(host);
  await h.frame(); await h.frame();
  assert.equal(h.backdrop.stats().cards, 6, 'six cards in the first pass');
  await h.frame(); await h.frame();
  assert.equal(h.backdrop.stats().cards, 12, 'six more after the next paint');
  await h.flush();
  assert.equal(h.backdrop.stats().cards, 14);
  assert.equal(h.backdrop.stats().passes, 3);
});

test('drawing a badge tracks its card; a browser without a readable canvas keeps the plain pill', async t => {
  const bare = '<div class="card" data-id="a"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div></div>';
  const h = setup(t, { html: bare, trending: [{ source: 'tmdb-day', movies: { 1: 3 }, series: {} }] });
  h.JE.initializeStatusTags();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.backdrop.stats().watching, 0);
  h.backdrop.track(null);
  assert.equal(h.backdrop.stats().watching, 0);
  const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
  // No layout controller here: the host is the render target and the badge is appended to it.
  h.renderers.get('status').render(h.host, { Id: 'm1', Type: 'Movie', ProviderIds: { Tmdb: '1' }, DateCreated: old, PremiereDate: old }, { stripRevision: 'none' });
  assert.ok(h.host.querySelector('.status-tag'), 'the trending badge is drawn');
  assert.equal(h.backdrop.stats().watching, 1, 'and its card is watched');
  h.JE.tagDirectPlay?.reset?.();

  const blind = setup(t);
  layout(blind);
  blind.window.HTMLCanvasElement.prototype.getContext = () => null;
  blind.backdrop.track(blind.host);
  await blind.flush();
  assert.deepEqual(blind.layers(blind.slot), {});
  assert.equal(blind.decoded.length, 0, 'nothing is decoded for a picture that cannot be drawn');
  assert.equal(blind.backdrop.stats().watching, 0, 'and nothing stays watched in a browser that cannot do the pixel work');
  blind.backdrop.track(blind.host);
  assert.equal(blind.backdrop.stats().watching, 0, 'nor is a card tracked again');
});

test('pictures of an older layout are not put back when the artwork goes and returns', async t => {
  const h = setup(t);
  layout(h);
  h.backdrop.track(h.host);
  await h.flush();
  assert.equal(h.layers(h.slot)['background-size'], '78px 22px');
  // The tag grows while the artwork is dimmed: the layout is read, and there is nothing to draw.
  h.style(h.art, { opacity: '0.4' });
  layout(h, { tagLeft: 148.9, tagWidth: 145.5 });
  h.tag.textContent = 'Returns Oct 4';
  await h.flush();
  assert.deepEqual(h.layers(h.slot), {});
  h.style(h.art, { opacity: '1' });
  // The lazy loader parks the artwork and puts it back: the card has not moved since it was last read,
  // but the pictures it kept are those of the narrow tag.
  h.art.style.backgroundImage = 'none';
  await h.flush();
  h.art.style.backgroundImage = `url('${ART}')`;
  await h.flush();
  assert.equal(h.layers(h.slot)['background-size'], '145px 22px', 'drawn for the tag as it is now');
  assert.equal(h.backdrop.stats().reused, 0);
});

test('a card measured while a transform scales it keeps what it has and is read when that is over', async t => {
  const h = setup(t);
  layout(h);
  // Laid out 200 × 300; a focused card on a TV is drawn 18% larger.
  Object.defineProperty(h.art, 'offsetWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(h.art, 'offsetHeight', { configurable: true, get: () => 300 });
  h.backdrop.track(h.host);
  await h.flush();
  const first = h.layers(h.slot);
  assert.equal(first['background-size'], '78px 22px');
  const scaled = () => {
    h.rect(h.root, 82.4, 23.3, 318.4, 377.3);
    h.rect(h.art, 82.4, 23.3, 318.4, 377.3);
    h.rect(h.host, 82.4, 23.3, 318.4, 377.3);
    h.rect(h.slot, 89.5, 30.4, 311.3, 370.2);
    h.rect(h.group, 219.7, 30.4, 311.3, 56.1);
    h.rect(h.tag, 219.7, 30.4, 311.3, 56.1);
  };
  scaled();
  h.tag.setAttribute('title', 'Transcode: container mkv'); // anything that has the card measured
  await h.flush();
  assert.deepEqual(h.layers(h.slot), first, 'the scaled measurement is not written');
  assert.equal(h.backdrop.stats().drawn, 1);
  // Focus moves on: the card is as it was, and nothing it watches says so.
  layout(h);
  h.host.closest('.card').dispatchEvent(new h.window.Event('focusout', { bubbles: true }));
  await h.flush();
  assert.deepEqual(h.layers(h.slot), first);
  // A card first drawn while scaled gets its picture once the scale is gone.
  const late = setup(t);
  layout(late);
  Object.defineProperty(late.art, 'offsetWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(late.art, 'offsetHeight', { configurable: true, get: () => 300 });
  late.rect(late.art, 82.4, 23.3, 318.4, 377.3);
  late.backdrop.track(late.host);
  await late.flush();
  assert.deepEqual(late.layers(late.slot), {});
  layout(late);
  late.host.closest('.card').dispatchEvent(new late.window.Event('transitionend', { bubbles: true }));
  await late.flush();
  assert.equal(late.layers(late.slot)['background-size'], '78px 22px');
});

test('a tag that is itself translucent keeps the plain pill, and gets its picture back when it is opaque again', async t => {
  for (const which of ['tag', 'group']) {
    const h = setup(t);
    layout(h);
    h.style(h[which], { opacity: '0' });
    h.backdrop.track(h.host);
    await h.flush();
    assert.deepEqual(h.layers(h.slot), {}, `${which}: a picture would stay at full strength with no chip over it`);
    assert.equal(h.decoded.length, 0);
    h.style(h[which], { opacity: '1' });
    h.host.closest('.card').dispatchEvent(new h.window.Event('pointerleave'));
    await h.flush();
    assert.equal(h.layers(h.slot)['background-size'], '78px 22px', which);
  }
});

test('a canvas that answers with other pixels than were drawn is not used', async t => {
  const h = setup(t);
  layout(h);
  h.lying = true;
  h.backdrop.track(h.host);
  await h.flush();
  assert.deepEqual(h.layers(h.slot), {});
  assert.equal(h.decoded.length, 0, 'nothing is decoded for pictures that would be noise');
});

test('a content security policy that refuses data: images turns the pictures off', async t => {
  const h = setup(t);
  layout(h);
  h.backdrop.track(h.host);
  await h.flush();
  assert.equal(h.layers(h.slot)['background-size'], '78px 22px');
  const violation = (blockedURI, effectiveDirective) => h.document.dispatchEvent(Object.assign(new h.window.Event('securitypolicyviolation'), { blockedURI, effectiveDirective }));
  violation('https://example.test/x.png', 'img-src');
  violation('data', 'font-src');
  assert.equal(h.backdrop.isActive(), true, 'another refusal is not ours');
  violation('data', 'img-src');
  assert.equal(h.backdrop.isActive(), false);
  assert.deepEqual(h.layers(h.slot), {});
  assert.equal(h.backdrop.stats().watching, 0);
});

test('a user switch takes the outgoing user\'s pictures away at once', async t => {
  const h = setup(t);
  layout(h);
  h.backdrop.track(h.host);
  await h.flush();
  assert.equal(h.layers(h.slot)['background-size'], '78px 22px');
  h.userChanged();
  assert.deepEqual(h.layers(h.slot), {}, 'before any card is measured again');
});

/** Six cards with an empty tag host each, and the trending answer that gives each a badge. */
const BARE = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => `<div class="card" data-id="${id}"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div></div>`).join('');
const TRENDING = () => [{ source: 'tmdb-day', movies: { 1: 3, 2: 5, 3: 7, 4: 9, 5: 11, 6: 13 }, series: {} }];
const OLD = Date.now() - 400 * 24 * 60 * 60 * 1000;
/** Draw the trending badge of movie `n` on the nth tag host, as the pipeline would. */
function badge(h, n) {
  const host = h.document.querySelectorAll('.je-tag-host')[n - 1];
  h.renderers.get('status').render(host, { Id: `m${n}`, Type: 'Movie', ProviderIds: { Tmdb: String(n) }, DateCreated: OLD, PremiereDate: OLD }, { stripRevision: 'none' });
  return host;
}

test('the painter is fetched when the first status tag is drawn, once; tags never wait for it and it takes them up when it arrives', async t => {
  const asked = [];
  let arrived;
  const paces = [];
  const loader = { ensure(ids, options) { asked.push(ids); paces.push(options?.pace); return new Promise(resolve => { arrived = resolve; }); } };
  const h = setup(t, { html: BARE, trending: TRENDING(), painter: false, loader });
  h.JE.initializeStatusTags();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.JE.statusTagBackdrop, undefined);
  assert.deepEqual(asked, [], 'a page without a status tag asks for nothing');

  const first = badge(h, 1);
  assert.ok(first.querySelector('.status-tag'), 'the tag is drawn at once, with the plain pill');
  assert.deepEqual(asked.map(ids => [...ids]), [['tag-status-backdrop']]);
  assert.deepEqual(paces, ['boot'], 'fetched like the boot bundle: when the page is idle, at low priority');
  const second = badge(h, 2);
  assert.ok(second.querySelector('.status-tag'));
  assert.equal(asked.length, 1, 'one request, however many tags are drawn meanwhile');

  // The file runs: every tag drawn so far is its to back.
  h.arrive();
  arrived();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.backdrop.stats().watching, 2);
  badge(h, 3);
  assert.equal(h.backdrop.stats().watching, 3, 'from now on a drawn badge tracks its card directly');
  assert.equal(asked.length, 1);
});

test('a request that brought no painter waits before it is made again, twice as long each time; without a loader the pill stays plain', async t => {
  const asked = [];
  let h;
  const answers = [() => Promise.resolve(), () => Promise.reject(new Error('offline')), () => { throw new Error('no such group'); }, () => { h.arrive(); return Promise.resolve(); }];
  const loader = { ensure(ids) { asked.push(ids); return answers[asked.length - 1](); } };
  h = setup(t, { html: BARE, trending: TRENDING(), painter: false, loader });
  let now = 1_000_000;
  h.window.Date.now = () => now;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  h.JE.initializeStatusTags();
  await tick();
  // The pauses' own timers, apart from the status module's other ones.
  const pauses = [];
  h.window.setTimeout = (fn, ms) => { if ([5000, 10000, 20000].includes(ms)) pauses.push({ fn, ms }); return 0; };
  const firePauses = () => { for (const pause of pauses.splice(0)) pause.fn(); };
  assert.ok(badge(h, 1).querySelector('.status-tag'), 'the tag is drawn whatever the loader answers');
  assert.equal(asked.length, 1);
  await tick();
  // Nothing came. The next tags do not ask again at once: every tag of a page would, each a request that fails.
  badge(h, 2);
  now += 4999;
  badge(h, 3);
  assert.equal(asked.length, 1, 'not within five seconds');
  now += 1;
  badge(h, 4);
  assert.equal(asked.length, 2, 'the first tag drawn after the pause asks');
  await tick();
  assert.deepEqual(pauses.map(pause => pause.ms), [5000, 10000]);
  now += 9999;
  badge(h, 5);
  firePauses();
  assert.equal(asked.length, 2, 'the pause doubles: neither a tag nor a timer asks before it is over');
  now += 1;
  badge(h, 6);
  assert.equal(asked.length, 3);
  await tick();
  assert.equal(h.JE.statusTagBackdrop, undefined);
  // A page that has settled draws no further tag: the timer of the last pause asks while a status tag is still there.
  assert.deepEqual(pauses.map(pause => pause.ms), [20000]);
  now += 20000;
  firePauses();
  assert.equal(asked.length, 4);
  await tick();
  assert.equal(h.backdrop.stats().watching, 6, 'and the painter that came takes up every tag');
  assert.deepEqual(pauses, [], 'nothing is asked, and no pause armed, once it is there');

  // The old loader (everything in one bundle) or none: nothing to ask, nothing thrown.
  const bare = setup(t, { html: BARE, trending: TRENDING(), painter: false });
  bare.JE.initializeStatusTags();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(badge(bare, 1).querySelector('.status-tag'));
  assert.deepEqual(bare.layers(bare.document.querySelector('.je-tag-host')), {});
});
