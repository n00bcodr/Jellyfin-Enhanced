import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Resting flow: a card whose tags need no layer of their own is marked
// data-je-flow by the layout controller, and the stylesheet lays its slots
// out as grid items instead of positioned boxes (same boxes, same paint
// order). These tests pin which cards are marked, and the rules behind it.

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const card = (id = ID) => `<div class="card overflowPortraitCard" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer coveredImage cardContent"></div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardText cardText-first">Title</div></div></div>`;
/** The settings panel's sample card: a host outside any library card. */
const sample = `<div class="je-mtp"><div class="je-mtp-card" data-id="${ID}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="je-tag-host"></div></div><div class="cardText">Title</div></div></div></div>`;

const entry = () => ({
  Type: 'Movie', TmdbId: '42', Genres: ['Drama', 'Crime'], CommunityRating: 8.12, CriticRating: 91, OfficialRating: 'PG-13', AudioLanguages: ['en'],
  StreamData: { Streams: [{ Type: 'Video', Codec: 'hevc', Height: 2160, DisplayTitle: '4K HEVC' }], Sources: [{ Path: 'Movie (2020).mkv', Name: 'Movie (2020)' }], ItemName: 'Movie', ItemPath: 'Movie (2020).mkv' },
});

/** The real renderers and layout controller over one card, in a browser that has (or lacks) what flow needs. */
function setup(t, { html = card(), settings = {}, plugin = {}, supports = () => true, globals = {} } = {}) {
  const renderers = new Map();
  const asked = [];
  const h = createHarness({
    html,
    globals: { CSS: { supports: (...args) => { asked.push(args.join(': ')); return supports(...args); } }, ...globals },
    JE: {
      currentSettings: { qualityTagsEnabled: true, ratingTagsEnabled: true, ageRatingTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', ...settings },
      pluginConfig: { TagCacheServerMode: true, ...plugin },
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
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js',
    'tags/rating-sources.js', 'tags/qualitytags.js', 'tags/genretags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js']) h.load(file);
  const JE = h.JE;
  JE.initializeQualityTags(); JE.initializeGenreTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags();
  const host = () => h.document.querySelector('.je-tag-host');
  return Object.assign(h, {
    layout: JE.core.tagLayout, host, asked, renderers,
    render() { for (const [, r] of renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(host(), entry(), ID); },
    flow: () => host().dataset.jeFlow,
    async apply(changes) { Object.assign(JE.currentSettings, changes); await JE.reinitializeTagLayout(); },
    /** A language group wrapper with one flag, dimmed when partial. */
    flags(partial) {
      const wrap = h.document.createElement('div');
      wrap.className = 'language-overlay-container';
      wrap.innerHTML = `<img class="language-flag${partial ? ' language-flag-partial' : ''}" alt="English" src="http://jellyfin.test/flags/gb.svg">`;
      return wrap;
    },
  });
}

const V1 = { tagLayoutSettingsVersion: 1 };
/** Corners profile putting quality on one anchor. */
const onAnchor = slot => ({ corners: { groups: [{ group: 'quality', slot }] } });

test('a corners card flows, with or without genre icons, and the mark follows the groups it holds', async t => {
  const h = setup(t);
  h.render();
  assert.equal(h.host().dataset.jeLayout, 'corners');
  assert.equal(h.flow(), '1', 'quality, rating and age rating: nothing that needs a layer');
  await h.apply({ genreTagsEnabled: true });
  h.render();
  assert.ok(h.host().querySelector('.genre-tag > .genre-text'));
  assert.equal(h.flow(), '1', 'a resting card shows no genre name, so its icons need not be positioned');
  assert.equal(h.host().hasAttribute('data-je-live'), false);
  h.layout.removeGroup(h.host(), 'genre');
  assert.equal(h.flow(), '1');
});

/** Dispatch a bubbling pointer event the way the browser does when the pointer crosses elements. */
function pointer(h, type, target, relatedTarget = null) {
  const event = new h.window.Event(type, { bubbles: true });
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
  target.dispatchEvent(event);
}

/** Make `card.matches(':hover')` answer as if the pointer were (or were not) on the card. */
function hover(h, on) {
  const card = h.document.querySelector('.card');
  const matches = h.window.Element.prototype.matches;
  card.matches = function (selector) { return selector === ':hover' ? on : matches.call(this, selector); };
  return card;
}

test('the pointer on a card with genre icons lays it out positioned so their names can float, and it rests again once the pointer has gone', async t => {
  const timers = [];
  const h = setup(t, { settings: { genreTagsEnabled: true }, globals: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; } } });
  h.render();
  const host = h.host();
  const card = hover(h, true);
  assert.equal(h.flow(), '1');
  // The names start at opacity 0 for the pass that first renders them, then are let go to fade in.
  const seen = [];
  const read = h.window.getComputedStyle;
  h.window.getComputedStyle = function (el, ...rest) { if (el.classList?.contains('genre-text')) seen.push(host.dataset.jeLive); return read.call(this, el, ...rest); };
  pointer(h, 'pointerover', card.querySelector('.cardImageContainer'));
  assert.ok(seen.includes('in'), 'styles were read while the names were held at their starting opacity');
  assert.equal(host.dataset.jeLive, '1');
  assert.equal(h.flow(), '1', 'the mark stays: only the live state lifts the flow rules');
  // Moving inside the card changes nothing.
  pointer(h, 'pointerout', card.querySelector('.cardImageContainer'), card.querySelector('.cardOverlayContainer'));
  assert.equal(timers.filter(x => x.fn && x.ms === 200).length, 0);
  // Leaving it: back to flow after the names' fade, unless the pointer returned.
  hover(h, false);
  pointer(h, 'pointerout', card.querySelector('.cardImageContainer'), h.document.body);
  const rest = timers.filter(x => x.fn && x.ms === 200);
  assert.equal(rest.length, 1);
  assert.equal(host.dataset.jeLive, '1', 'still positioned while the names fade');
  const due = rest[0].fn;
  rest[0].fn = null;
  due();
  assert.equal(host.hasAttribute('data-je-live'), false);
  // Leave and come straight back: the pending rest is dropped.
  hover(h, true);
  pointer(h, 'pointerover', card.querySelector('.cardImageContainer'));
  pointer(h, 'pointerout', card.querySelector('.cardImageContainer'), h.document.body);
  pointer(h, 'pointerover', card.querySelector('.cardImageContainer'));
  assert.equal(timers.filter(x => x.fn && x.ms === 200).length, 0);
  assert.equal(host.dataset.jeLive, '1');
});

test('nothing goes live for focus, for a card without genre icons, or while Hide Tags on Hover hides the card under the pointer', async t => {
  const h = setup(t, { settings: { genreTagsEnabled: true } });
  h.render();
  const host = h.host();
  const card = hover(h, true);
  card.querySelector('.cardImageContainer').dispatchEvent(new h.window.Event('focusin', { bubbles: true }));
  assert.equal(host.hasAttribute('data-je-live'), false, 'focus does not show genre names');
  pointer(h, 'pointerout', card.querySelector('.cardImageContainer'), h.document.body);
  h.document.body.classList.add('je-tags-hide-on-hover');
  pointer(h, 'pointerover', card.querySelector('.cardImageContainer'));
  assert.equal(host.hasAttribute('data-je-live'), false, 'the host fades out instead: nothing to show');
  h.document.body.classList.remove('je-tags-hide-on-hover');
  h.layout.removeGroup(host, 'genre');
  pointer(h, 'pointerover', card.querySelector('.cardImageContainer'));
  assert.equal(host.hasAttribute('data-je-live'), false, 'no names to float');
});

test('genre icons arriving on a card the pointer is already on show their names at once', async t => {
  const h = setup(t, { settings: { genreTagsEnabled: true } });
  hover(h, true);
  h.render();
  assert.equal(h.flow(), '1');
  assert.equal(h.host().dataset.jeLive, '1');
});

test('genre names custom CSS shows inline keep their cards positioned', async t => {
  const h = setup(t, { settings: { genreTagsEnabled: true } });
  const style = h.document.createElement('style');
  style.textContent = '.genre-tag .genre-text { position: static !important; }';
  h.document.head.appendChild(style);
  h.render();
  assert.ok(h.host().querySelector('.genre-tag > .genre-text'));
  assert.equal(h.flow(), undefined, 'an inline name is part of the resting card');
  h.layout.removeGroup(h.host(), 'genre');
  assert.equal(h.flow(), '1', 'cards without genre icons are not held back');
});

test('a dimmed partial flag keeps the card positioned, and flow returns when it goes', t => {
  const h = setup(t);
  h.render();
  h.layout.commitGroup(h.host(), 'language', h.flags(true));
  assert.ok(h.host().querySelector('.language-flag-partial'));
  assert.equal(h.flow(), undefined, 'its opacity makes it a layer the chips after it must paint over');
  h.layout.commitGroup(h.host(), 'language', h.flags(false));
  assert.equal(h.flow(), '1');
});

test('centre anchors, Flush, Summary and Minimal keep the positioned layout; Tight, Bands and Caption flow', async t => {
  const h = setup(t, { settings: V1 });
  h.render();
  assert.equal(h.flow(), '1');
  for (const slot of ['tc', 'ml', 'c', 'mr', 'bc']) {
    await h.apply({ tagLayouts: onAnchor(slot) });
    assert.equal(h.flow(), undefined, `${slot} is positioned and transformed`);
  }
  await h.apply({ tagLayouts: onAnchor('bl'), tagEdgeSpacing: 'flush' });
  assert.equal(h.host().dataset.jeEdge, 'flush');
  assert.equal(h.flow(), undefined, 'a flush host clips to the card and rings its chips');
  await h.apply({ tagEdgeSpacing: 'tight' });
  assert.equal(h.flow(), '1');
  for (const [layout, expected] of [['bands', '1'], ['caption', '1'], ['summary', undefined], ['minimal', undefined], ['corners', '1']]) {
    await h.apply({ tagLayout: layout, tagEdgeSpacing: 'default' });
    assert.equal(h.host().dataset.jeLayout, layout);
    assert.equal(h.flow(), expected, layout);
  }
});

test('only library cards flow: a preview sample styles its own host', t => {
  const h = setup(t, { html: sample });
  h.render();
  assert.ok(h.host().querySelector('.quality-overlay-label'));
  assert.equal(h.flow(), undefined);
});

test('a browser missing any piece the flow rules are written with keeps every card positioned', t => {
  for (const missing of ['container-type: size', 'max-height: 1cqh', 'overflow: clip', 'transition-timing-function: linear(0, 1)']) {
    const h = setup(t, { supports: (prop, value) => `${prop}: ${value}` !== missing });
    h.render();
    assert.equal(h.flow(), undefined, `without ${missing}`);
    assert.ok(h.host().querySelector('.je-tag-slot[data-je-slot="tl"] .quality-overlay-label'), 'the card still shows its tags');
  }
  const h = setup(t);
  h.render();
  assert.deepEqual([...new Set(h.asked)].sort(), ['container-type: size', 'max-height: 1cqh', 'overflow: clip', 'transition-timing-function: linear(0, 1)'].sort(), 'asked once, for exactly these');
});

test('the switch turns flow off for cards already on the page, and back on', t => {
  const h = setup(t);
  h.render();
  assert.equal(h.flow(), '1');
  h.layout.restingFlow = false;
  h.layout.refreshPresentation();
  assert.equal(h.flow(), undefined);
  assert.ok(h.host().querySelector('.quality-overlay-label'));
  h.layout.restingFlow = true;
  h.layout.refreshPresentation();
  assert.equal(h.flow(), '1');
});

test('custom CSS can keep the positioned layout with --je-tag-flow: off, read again when the settings are re-applied', async t => {
  const h = setup(t);
  const root = h.document.documentElement;
  root.style.setProperty('--je-tag-flow', ' OFF ');
  h.render();
  assert.equal(h.flow(), undefined);
  root.style.removeProperty('--je-tag-flow');
  h.layout.refreshPresentation();
  assert.equal(h.flow(), undefined, 'the answer is kept between settings passes: no style read per card');
  await h.apply({});
  assert.equal(h.flow(), '1');
  root.style.setProperty('--je-tag-flow', 'off');
  await h.apply({});
  assert.equal(h.flow(), undefined);
});

test('clearing a card removes the mark with everything else', t => {
  const h = setup(t);
  h.render();
  assert.equal(h.flow(), '1');
  h.layout.clearCard(h.host());
  assert.equal(h.host().hasAttribute('data-je-flow'), false);
});

test('the stylesheet lays a flow card out as grid items with the same insets, and the bottom corners as rising grids', t => {
  const h = setup(t);
  const css = h.layout.buildStyles();
  const FLOW = '.je-tag-host[data-je-flow]:not([data-je-live])';
  const SLOT = `${FLOW} > .je-tag-slot`;
  const RISING = `${SLOT}:is([data-je-slot="bl"], [data-je-slot="br"])`;
  const rule = selector => {
    const at = css.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `rule for ${selector}`);
    return css.slice(at + selector.length, css.indexOf('}', at) + 1).replace(/\s+/g, ' ');
  };
  // The host: one cell every slot shares, and a size container so a height limit can be said in cqh.
  assert.match(rule(FLOW), /display: grid; grid-template: minmax\(0, 1fr\) \/ minmax\(0, 1fr\); container-type: size;/);
  // Slots and groups are no longer positioned; slots stop fading one by one only on a card marked to fade as one.
  assert.match(rule(SLOT), /position: static; grid-area: 1 \/ 1; min-width: 0; min-height: 0; \}/);
  assert.match(rule(`${FLOW}[data-je-fade] > .je-tag-slot`), /transition: none;/);
  assert.match(rule(`${SLOT} > [data-je-group]`), /position: static;/);
  // The corner inset (6px, or the edge spacing's) as a margin, and the indicator offset on top of it.
  assert.match(rule(`${SLOT}:is([data-je-slot="tl"], [data-je-slot="tr"], [data-je-slot="bl"], [data-je-slot="br"])`), /margin: var\(--je-edge, 6px\);/);
  assert.ok(css.includes(`.cardIndicators ~ ${FLOW}[data-je-indicator-gap] > .je-tag-slot[data-je-slot="tr"] {\n                margin-top: calc(var(--je-edge, 6px) + calc(clamp(20px, 3vw, 30px) * var(--je-tag-scale, 1)));`));
  // Bottom corners: a grid filled from the last row up, in document (paint) order, with the gap as a top margin.
  assert.match(rule(RISING), /display: grid; grid-template-rows: repeat\(12, auto\); grid-template-columns: minmax\(0, 1fr\); align-content: end; row-gap: 0;/);
  assert.match(rule(`${SLOT}[data-je-slot="bl"]`), /justify-items: start;/);
  assert.match(rule(`${SLOT}[data-je-slot="br"]`), /justify-items: end;/);
  assert.match(rule(`${RISING} > *`), /margin-top: calc\(4px \* var\(--je-tag-scale, 1\) \* var\(--je-tag-gap, 1\)\);/);
  for (let n = 1; n <= 12; n++) assert.ok(css.includes(`${RISING} > :nth-child(${n}) { grid-row: ${13 - n}; }`), `child ${n} from the bottom`);
  // A grid item's percentage height is its row's: the containers' limit is restated against the host.
  assert.match(rule(`${RISING} > :is(.quality-overlay-container, .language-overlay-container, .genre-overlay-container)`), /max-height: 90cqh;/);
  assert.match(css, /@media \(max-width: 480px\) \{\s*\.je-tag-host\[data-je-flow\]:not\(\[data-je-live\]\)[^{]*> :is\(\.quality-overlay-container, \.genre-overlay-container\) \{ max-height: 85cqh; \}/);
  // Bands and the caption's poster stack.
  assert.match(rule(`${SLOT}[data-je-slot="top"]`), /align-self: start;/);
  assert.match(rule(`${SLOT}[data-je-slot="bottom"]`), /align-self: end;/);
  assert.match(rule(`${SLOT}[data-je-slot="poster"]`), /justify-self: start; align-self: start; margin: 6px;/);
  // Nothing inside is a layer: icons hold no name (it is left out until the card goes live), and the group clip is not a scroll container.
  assert.match(rule(`${FLOW} .genre-tag`), /position: static;/);
  assert.match(rule(`${FLOW} .genre-tag > .genre-text`), /display: none;/);
  assert.match(rule('.je-tag-host.je-tag-host[data-je-live="in"] .genre-tag > .genre-text'), /opacity: 0;/);
  assert.match(rule(`${FLOW} :is(.quality-overlay-container, .language-overlay-container)`), /overflow: clip;/);
  // A legacy card keeps its unmultiplied gap, as its slots always had.
  assert.ok(css.includes('.je-tag-host[data-je-legacy][data-je-flow]:not([data-je-live]) > .je-tag-slot:is([data-je-slot="bl"], [data-je-slot="br"]) > * { margin-top: 4px;}'));
});

test('the positioned rules are untouched, and Hide Tags on Hover leaves the slots of a card that fades as one to its host', t => {
  const h = setup(t);
  const css = h.layout.buildStyles();
  assert.match(css, /\.je-tag-host > \.je-tag-slot \{\s*position: absolute;\s*display: flex;/);
  assert.match(css, /\.je-tag-host > \.je-tag-slot > \[data-je-group\] \{\s*position: relative;/);
  assert.match(css, /\[data-je-slot="br"\] \{\s*inset: 6px;/);
  assert.ok(css.includes('body.je-tags-hide-on-hover .card:hover .je-tag-host:not([data-je-fade]) > .je-tag-slot:not([data-je-slot="hover"]),'));
  assert.equal(css.includes('body.je-tags-hide-on-hover .card:hover .je-tag-host > .je-tag-slot:not([data-je-slot="hover"]),'), false);
});

/** The real pipeline's start-up, keeping the stylesheets it injects. */
function pipelineSheets(t) {
  const sheets = new Map();
  const h = createHarness({
    html: card(),
    globals: { requestIdleCallback: () => 0, setTimeout: () => 0, clearTimeout() {} },
    apiClient: { ajax: () => new Promise(() => {}) },
    JE: {
      currentSettings: { genreTagsEnabled: true, tagsHideOnHover: true },
      pluginConfig: { TagCacheServerMode: false },
      t: key => key,
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS: (id, css) => sheets.set(id, css) },
    },
  });
  t.after(() => h.close());
  for (const file of ['core/dom-observer.js', 'core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-pipeline.js', 'tags/tag-layout-styles.js']) h.load(file);
  h.JE.tagPipeline.initialize();
  return Object.assign(h, { sheets });
}

test('a card marked to fade as one does so on the two old fades multiplied, and eases back; every other card keeps the old rules', t => {
  const h = pipelineSheets(t);
  const css = h.sheets.get('je-tag-hover-fade').replace(/\s+/g, ' ');
  const HOVERED = 'body.je-tags-hide-on-hover .card:hover .je-tag-host';
  const LAYOUTS = ':not([data-je-layout="summary"]):not([data-je-layout="minimal"])';
  // The rule every card had stays as it was (with each slot's own fade, in the layout sheet).
  assert.ok(css.includes(`${HOVERED}${LAYOUTS} { opacity: 0 !important; transition: opacity 0.15s ease; }`));
  // Back in: the host eases where its slots used to.
  assert.ok(css.includes('body.je-tags-hide-on-hover .je-tag-host[data-je-fade] { transition: opacity 0.15s ease; }'));
  // Out: 1 - (1 - ease(t))^2 for cubic-bezier(0.25, 0.1, 0.25, 1), within a third of one colour level everywhere.
  const out = new RegExp(`${HOVERED.replace(/[.[\]]/g, '\\$&')}\\[data-je-fade\\]${LAYOUTS.replace(/[.[\]()"=]/g, '\\$&')} \\{ transition: opacity 0\\.15s (linear\\([^)]*\\)); \\}`).exec(css);
  assert.ok(out, 'the hovered host has a sampled easing');
  const stops = out[1].slice('linear('.length, -1).split(', ').map(stop => stop.split(' ')).map(([value, at], i, all) => [Number(value), at ? parseFloat(at) / 100 : i / (all.length - 1)]);
  /** CSS `ease` at time x (bisection on the curve's x polynomial). */
  const ease = x => { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; const cx = 3 * (1 - m) ** 2 * m * 0.25 + 3 * (1 - m) * m * m * 0.25 + m ** 3; if (cx < x) lo = m; else hi = m; } const m = (lo + hi) / 2; return 3 * (1 - m) ** 2 * m * 0.1 + 3 * (1 - m) * m * m + m ** 3; };
  const curve = x => 1 - (1 - ease(x)) ** 2;
  assert.deepEqual([stops[0], stops.at(-1)], [[0, 0], [1, 1]]);
  let worst = 0;
  for (let k = 1; k < 2000; k++) {
    const x = k / 2000;
    const i = stops.findIndex(([, at]) => at >= x);
    const [v0, x0] = stops[i - 1], [v1, x1] = stops[i];
    worst = Math.max(worst, Math.abs(v0 + (v1 - v0) * (x - x0) / (x1 - x0) - curve(x)));
  }
  assert.ok(worst * 255 < 0.34, `at most ${(worst * 255).toFixed(3)} of a colour level from the curve`);
  // Reduced motion never had the slot fade: the host eases out and snaps back.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ body\.je-tags-hide-on-hover \.je-tag-host\[data-je-fade\] \{ transition: none; \} body\.je-tags-hide-on-hover \.card:hover \.je-tag-host\[data-je-fade\]:not\(\[data-je-layout="summary"\]\):not\(\[data-je-layout="minimal"\]\) \{ transition: opacity 0\.15s ease; \} \}/);
});

/** Give every element of the card a box, the way a laid-out page would: each slot's groups stacked in its corner. */
function layOut(h, { width = 200, height = 300, groupSize = 40 } = {}) {
  const proto = h.window.Element.prototype;
  const rect = (x, y, w, hh) => ({ x, y, left: x, top: y, right: x + w, bottom: y + hh, width: w, height: hh });
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function () {
    if (this.classList.contains('je-tag-host')) return rect(0, 0, width, height);
    if (this.classList.contains('je-tag-slot')) return rect(6, 6, width - 12, height - 12);
    const slot = this.closest('.je-tag-slot')?.dataset.jeSlot;
    if (!slot || !this.dataset.jeGroup) return rect(0, 0, 0, 0);
    const index = Array.from(this.parentElement.children).indexOf(this);
    const x = slot.endsWith('l') ? 6 : width - 6 - groupSize;
    const y = slot.startsWith('t') ? 6 + index * (groupSize + 4) : height - 6 - (index + 1) * groupSize - index * 4;
    return rect(x, y, groupSize, groupSize);
  };
  Object.defineProperty(h.host(), 'clientWidth', { configurable: true, get: () => width });
  return () => { proto.getBoundingClientRect = original; };
}
const frame = h => new Promise(resolve => h.window.requestAnimationFrame(() => resolve()));

test('a flow card whose slots are clear of each other is marked to fade as one; overlapping slots keep the five fades', async t => {
  const h = setup(t);
  h.document.body.classList.add('je-tags-hide-on-hover');
  layOut(h);
  h.render();
  assert.equal(h.flow(), '1');
  assert.equal(h.host().hasAttribute('data-je-fade'), false, 'nothing is assumed before the card is measured');
  await frame(h);
  assert.equal(h.host().dataset.jeFade, 'one', 'top-left quality and bottom-right rating are far apart on a 200x300 card');
  // A card so small its corner stacks come within paint reach of each other.
  layOut(h, { width: 90, height: 96 });
  h.layout.refreshPresentation();
  await frame(h);
  assert.equal(h.flow(), '1');
  assert.equal(h.host().hasAttribute('data-je-fade'), false, 'chips of two slots may overlap: the host and every slot fade, as before');
});

test('nothing is measured while the pointer does not hide tags, and a card that stops flowing loses the mark', async t => {
  const h = setup(t, { settings: V1 });
  layOut(h);
  let reads = 0;
  const proto = h.window.Element.prototype;
  const rect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function () { reads++; return rect.call(this); };
  h.render();
  await frame(h);
  assert.equal(h.host().hasAttribute('data-je-fade'), false);
  assert.equal(reads, 0, 'no fade to choose: no layout read');
  h.document.body.classList.add('je-tags-hide-on-hover');
  h.layout.refreshPresentation();
  await frame(h);
  assert.equal(h.host().dataset.jeFade, 'one');
  await h.apply({ tagLayout: 'summary' });
  assert.equal(h.flow(), undefined);
  assert.equal(h.host().hasAttribute('data-je-fade'), false);
});

/** Add a custom stylesheet the way Jellyfin's custom CSS box does. */
function customCss(h, text) {
  const style = h.document.createElement('style');
  style.textContent = text;
  h.document.head.appendChild(style);
  return style;
}

test('custom CSS that nudges a group, moves a slot or re-lays a corner stack keeps its cards positioned, where it always worked', async t => {
  for (const [css, why] of [
    ['.rating-overlay-container { top: -4px !important; left: -4px !important; }', 'a group nudged with top/left'],
    ['.je-tag-slot[data-je-slot="tl"] { top: 14px !important; left: 14px !important; }', 'a slot with another inset'],
    ['.je-tag-slot[data-je-slot="br"] { flex-direction: row-reverse !important; }', 'a corner stack turned into a row'],
    // (Longhands: jsdom does not expand the gap shorthand.)
    ['.je-tag-slot[data-je-slot="br"] { row-gap: 12px !important; column-gap: 12px !important; }', 'a rising stack with another gap'],
  ]) {
    const h = setup(t);
    h.render();
    assert.equal(h.flow(), '1');
    // (After JE's own sheets, as jsdom's cascade is by order alone; a browser honours !important wherever the rule sits.)
    customCss(h, css);
    await h.apply({});
    assert.ok(h.host().querySelector('.rating-tag'));
    assert.equal(h.flow(), undefined, why);
  }
});

test('custom CSS that makes a chip a layer (opacity, transform, filter, z-index, position) keeps its cards positioned', async t => {
  for (const css of [
    '.quality-overlay-label { opacity: 0.85; }',
    '.rating-overlay-container { transform: scale(0.9); }',
    '.age-rating-tag { filter: saturate(0.5); }',
    '.rating-tag { z-index: 3; }',
    '.rating-text { position: relative; }',
    '.quality-overlay-container { translate: 2px 2px; }',
  ]) {
    const h = setup(t);
    customCss(h, css);
    h.render();
    assert.equal(h.flow(), undefined, css);
  }
});

test('only the cards the custom rule reaches stay positioned, and the styles are asked once per kind of element', async t => {
  const h = setup(t, { html: card() + card('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') });
  const hosts = () => Array.from(h.document.querySelectorAll('.je-tag-host'));
  const renderInto = (host, e) => { for (const [, r] of h.renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(host, e, host.closest('.card').dataset.id); };
  const withAge = entry();
  const without = { ...entry(), OfficialRating: null };
  renderInto(hosts()[0], withAge);
  // (After JE's own sheets: see the test above.)
  customCss(h, '.age-rating-overlay-container { top: 3px !important; }');
  let asked = 0;
  const read = h.window.getComputedStyle;
  h.window.getComputedStyle = function (...args) { asked++; return read.apply(this, args); };
  await h.apply({});
  const first = asked;
  assert.ok(first > 0);
  renderInto(hosts()[1], without);
  assert.equal(hosts()[0].dataset.jeFlow, undefined, 'its age rating group is nudged');
  assert.equal(hosts()[1].dataset.jeFlow, '1', 'no age rating group on this card: nothing custom reaches it');
  assert.equal(asked, first, 'the second card holds no kind of element the first did not');
  // The same card drawn again asks nothing.
  h.layout.refreshPresentation();
  assert.equal(asked, first);
  // New settings (or a user switch) forget the verdicts: the page's CSS may have changed with them.
  await h.apply({});
  assert.ok(asked > first);
});
