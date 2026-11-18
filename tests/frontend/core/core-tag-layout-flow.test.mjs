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

/**
 * Give every element of every card a box, the way a laid-out page would: each slot's groups stacked in its
 * corner. `moved(el, flow)` may shift a box ([dx, dy]) in one layout only, as custom CSS written against the
 * positioned layout does where flow ignores it.
 */
function layOut(h, { width = 200, height = 300, groupSize = 40, moved = () => null } = {}) {
  const proto = h.window.Element.prototype;
  const rect = (x, y, w, hh) => ({ x, y, left: x, top: y, right: x + w, bottom: y + hh, width: w, height: hh });
  proto.getBoundingClientRect = function () {
    const host = this.closest('.je-tag-host');
    const shift = (host && moved(this, host.dataset.jeFlow === '1' && !host.dataset.jeLive)) || [0, 0];
    if (this.classList.contains('je-tag-host')) return rect(0, 0, width, height);
    if (this.classList.contains('je-tag-slot')) return rect(6 + shift[0], 6 + shift[1], width - 12, height - 12);
    const slot = this.closest('.je-tag-slot')?.dataset.jeSlot;
    if (!slot || this.parentElement?.classList.contains('je-tag-slot') !== true) return rect(0, 0, 0, 0);
    const index = Array.from(this.parentElement.children).indexOf(this);
    const x = slot.endsWith('l') ? 6 : width - 6 - groupSize;
    const y = slot.startsWith('t') ? 6 + index * (groupSize + 4) : height - 6 - (index + 1) * groupSize - index * 4;
    return rect(x + shift[0], y + shift[1], groupSize, groupSize);
  };
  Object.defineProperty(h.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('je-tag-host') ? width : 0; } });
}

/** The real renderers and layout controller over one card, in a browser that has (or lacks) what flow needs. */
function setup(t, { html = card(), settings = {}, plugin = {}, supports = () => true, globals = {} } = {}) {
  const renderers = new Map();
  const asked = [];
  // Frames run by hand (settle), so "after the next paint" is a point in the test.
  const frames = [];
  const h = createHarness({
    html,
    globals: { CSS: { supports: (...args) => { asked.push(args.join(': ')); return supports(...args); } }, requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, ...globals },
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
  /** Run the frames queued so far, and the ones they queue (the after-paint passes). */
  const settle = () => { for (let i = 0; i < 20 && frames.length; i++) for (const fn of frames.splice(0)) fn(); };
  Object.assign(h, { host, settle });
  // A laid-out page: every host has a size and every slot and group a box, the same in either layout.
  layOut(h);
  return Object.assign(h, {
    layout: JE.core.tagLayout, asked, renderers,
    render() { for (const [, r] of renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(host(), entry(), ID); },
    /** The mark once the page has settled (a kind of slot is asked about after the paint that first shows it). */
    flow: () => { settle(); return host().dataset.jeFlow; },
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

/** Make a card answer `matches(':hover')` and `matches(':focus-within')` as if the pointer were on it or it held focus. */
function hover(h, on, card = h.document.querySelector('.card'), focused = false) {
  const matches = h.window.Element.prototype.matches;
  card.matches = function (selector) { return selector === ':hover' ? on : selector === ':focus-within' ? focused : matches.call(this, selector); };
  return card;
}
/** Timers by hand: `due(ms)` runs the pending ones of that delay. */
function handTimers() {
  const timers = [];
  return {
    globals: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; } },
    pending: ms => timers.filter(x => x.fn && x.ms === ms).length,
    due(ms) { for (const timer of timers.filter(x => x.fn && x.ms === ms)) { const fn = timer.fn; timer.fn = null; fn(); } },
  };
}
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('the pointer on a card with genre icons lays it out positioned so their names can float, and it rests again once the pointer has gone', async t => {
  const timers = [];
  const h = setup(t, { settings: { genreTagsEnabled: true }, globals: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; } } });
  h.render();
  const host = h.host();
  assert.equal(h.flow(), '1');
  const card = hover(h, true);
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

test('a card that holds focus or has the pointer on it is laid out positioned, genre icons or not; a pointer that hides the tags changes nothing', async t => {
  const timers = handTimers();
  const h = setup(t, { globals: timers.globals });
  h.render();
  const host = h.host();
  assert.equal(h.flow(), '1');
  assert.equal(host.querySelector('.genre-tag'), null);
  const card = hover(h, false, undefined, true);
  const image = card.querySelector('.cardImageContainer');
  // Focus: CSS written for a focused card finds the layout it was written against.
  image.dispatchEvent(new h.window.Event('focusin', { bubbles: true }));
  assert.equal(host.dataset.jeLive, '1');
  assert.equal(h.flow(), '1', 'the mark stays: only the live state lifts the flow rules');
  hover(h, false, card, false);
  const out = new h.window.Event('focusout', { bubbles: true });
  Object.defineProperty(out, 'relatedTarget', { value: h.document.body });
  image.dispatchEvent(out);
  assert.equal(host.dataset.jeLive, '1', 'not at once');
  timers.due(200);
  assert.equal(host.hasAttribute('data-je-live'), false, 'at rest again');
  // The pointer, where it hides the tags: the host fades out, there is nothing to lay out for.
  h.document.body.classList.add('je-tags-hide-on-hover');
  hover(h, true, card);
  pointer(h, 'pointerover', image);
  assert.equal(host.hasAttribute('data-je-live'), false);
  pointer(h, 'pointerout', image, h.document.body);
  timers.due(200);
  // The pointer, where it does not.
  h.document.body.classList.remove('je-tags-hide-on-hover');
  pointer(h, 'pointerover', image);
  assert.equal(host.dataset.jeLive, '1', 'no genre names needed: a rule for .card:hover may move or layer any tag');
});

test('focus first, then the pointer: the card is live from the focus on, so its genre names are bounded where they are rendered', async t => {
  const timers = handTimers();
  const h = setup(t, { settings: { genreTagsEnabled: true }, globals: timers.globals });
  h.render();
  const host = h.host();
  assert.equal(h.flow(), '1');
  assert.equal(host.hasAttribute('data-je-genre-bound'), false);
  const card = hover(h, false, undefined, true);
  const image = card.querySelector('.cardImageContainer');
  image.dispatchEvent(new h.window.Event('focusin', { bubbles: true }));
  assert.equal(host.dataset.jeLive, '1');
  assert.equal(host.dataset.jeGenreBound, '1', 'bounded while live');
  hover(h, true, card, true);
  pointer(h, 'pointerover', image);
  assert.equal(host.dataset.jeLive, '1', 'the names can show: the host was never left in flow under the pointer');
  // At rest a card renders no genre name: a fit pass on it must not bound names from empty boxes.
  hover(h, false, card, false);
  pointer(h, 'pointerout', image, h.document.body);
  timers.due(200);
  assert.equal(host.hasAttribute('data-je-live'), false);
  for (const name of host.querySelectorAll('.genre-text')) { delete name.dataset.jeGenreFit; name.style.removeProperty('max-width'); }
  h.layout.flushFit?.();
  image.dispatchEvent(new h.window.Event('focusin', { bubbles: true }));
  hover(h, false, card, false);
  assert.ok(Array.from(host.querySelectorAll('.genre-text')).every(name => !name.style.maxWidth || host.dataset.jeLive), 'no bound written from a resting card');
});

test('a touch leaves its card hovered and sends no pointerout later: the host rests when the pointer shows up elsewhere', async t => {
  const timers = handTimers();
  const h = setup(t, { html: card() + card(OTHER), settings: { genreTagsEnabled: true }, globals: timers.globals });
  const [a, b] = Array.from(h.document.querySelectorAll('.card'));
  const hostOf = el => el.querySelector('.je-tag-host');
  for (const el of [a, b]) for (const [, r] of h.renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(hostOf(el), entry(), el.dataset.id);
  h.settle();
  assert.deepEqual([hostOf(a).dataset.jeFlow, hostOf(b).dataset.jeFlow], ['1', '1']);
  // Tap A: over, down, up, out, and the card stays :hover.
  hover(h, true, a); hover(h, false, b);
  pointer(h, 'pointerover', a.querySelector('.cardImageContainer'));
  pointer(h, 'pointerout', a.querySelector('.cardImageContainer'), h.document.body);
  timers.due(200);
  assert.equal(hostOf(a).dataset.jeLive, '1', 'still hovered: its names are showing');
  assert.equal(timers.pending(200), 0);
  // Tap B: hover moves on, and nothing tells A.
  hover(h, false, a); hover(h, true, b);
  pointer(h, 'pointerover', b.querySelector('.cardImageContainer'));
  assert.equal(hostOf(b).dataset.jeLive, '1');
  timers.due(200);
  assert.equal(hostOf(a).hasAttribute('data-je-live'), false, 'A is at rest again');
  // A card cleared while live does not keep the state for its next item.
  h.layout.clearCard(hostOf(b));
  assert.equal(hostOf(b).hasAttribute('data-je-live'), false);
});

test('tags arriving on a card the pointer is already on are laid out positioned at once', async t => {
  const h = setup(t, { settings: { genreTagsEnabled: true } });
  // Another card of the kind has been seen: the browser's answer is known when this one is drawn.
  h.render();
  assert.equal(h.flow(), '1');
  h.layout.clearCard(h.host());
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
  for (const missing of ['container-type: size', 'max-height: 1cqh', 'overflow: clip']) {
    const h = setup(t, { supports: (prop, value) => `${prop}: ${value}` !== missing });
    h.render();
    assert.equal(h.flow(), undefined, `without ${missing}`);
    assert.ok(h.host().querySelector('.je-tag-slot[data-je-slot="tl"] .quality-overlay-label'), 'the card still shows its tags');
  }
  const h = setup(t);
  h.render();
  assert.deepEqual([...new Set(h.asked)].sort(), ['container-type: size', 'max-height: 1cqh', 'overflow: clip'].sort(), 'asked once, for exactly these');
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
  // Slots and groups are no longer positioned (and keep their own fade under Hide Tags on Hover).
  assert.match(rule(SLOT), /position: static; grid-area: 1 \/ 1; min-width: 0; min-height: 0; \}/);
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

test('the positioned rules and Hide Tags on Hover are as they were: the host and every slot fade, on every card', t => {
  const h = setup(t);
  const css = h.layout.buildStyles();
  assert.match(css, /\.je-tag-host > \.je-tag-slot \{\s*position: absolute;\s*display: flex;/);
  assert.match(css, /\.je-tag-host > \.je-tag-slot > \[data-je-group\] \{\s*position: relative;/);
  assert.match(css, /\[data-je-slot="br"\] \{\s*inset: 6px;/);
  assert.ok(css.includes('body.je-tags-hide-on-hover .card:hover .je-tag-host > .je-tag-slot:not([data-je-slot="hover"]),'));
  assert.equal(css.includes('data-je-fade'), false);
  // The host's own fade (the pipeline's sheet) is the one rule it always was: a flow card fades exactly like any other,
  // also part way through a fade the pointer cut short.
  const fade = pipelineSheets(t).sheets.get('je-tag-hover-fade').replace(/\s+/g, ' ').trim();
  assert.equal(fade, 'body.je-tags-hide-on-hover .card:hover .je-tag-host:not([data-je-layout="summary"]):not([data-je-layout="minimal"]) { opacity: 0 !important; transition: opacity 0.15s ease; }');
});

/** Add a custom stylesheet the way Jellyfin's custom CSS box does. */
function customCss(h, text) {
  const style = h.document.createElement('style');
  style.textContent = text;
  h.document.head.appendChild(style);
  return style;
}

/** Draw the entry's tags into one host of a page with several cards. */
function renderInto(h, host, e = entry()) {
  for (const [, r] of h.renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(host, e, host.closest('.card').dataset.id);
}
const hostsOf = h => Array.from(h.document.querySelectorAll('.je-tag-host'));

test('a kind of slot is asked about once, after the paint that first shows it, and its card rests in flow from then on', t => {
  const h = setup(t, { html: card() + card(OTHER) });
  const [first, second] = hostsOf(h);
  renderInto(h, first);
  assert.equal(first.dataset.jeFlow, undefined, 'drawn positioned: the browser has not laid this kind out both ways yet');
  assert.equal(h.layout.flowStats().probes, 0, 'and nothing is measured while the card is being drawn');
  h.settle();
  assert.equal(first.dataset.jeFlow, '1');
  const asked = h.layout.flowStats().probes;
  assert.ok(asked > 0);
  // A second card of the same kinds is in flow as it is drawn, with nothing asked.
  renderInto(h, second);
  assert.equal(second.dataset.jeFlow, '1');
  h.settle();
  h.layout.refreshPresentation();
  h.settle();
  assert.equal(h.layout.flowStats().probes, asked);
  assert.deepEqual(hostsOf(h).map(host => host.dataset.jeFlow), ['1', '1']);
});

test('custom CSS that moves a box keeps its kind of card positioned, with no opt-out: the browser lays it out differently in flow', t => {
  // What `.age-rating-overlay-container { top: -4px; left: -4px; }` does: honoured where the group is
  // positioned, ignored by a static grid item. A margin, an order, an alignment or padding on the host
  // show up the same way: as a box that is somewhere else.
  for (const [what, moved] of [
    ['a group nudged', (el, flow) => (!flow && el.classList.contains('age-rating-overlay-container') ? [-4, -4] : null)],
    ['a slot with another inset or margin', (el, flow) => (flow && el.dataset.jeSlot === 'br' ? [0, 30] : null)],
  ]) {
    const h = setup(t, { html: card() + card(OTHER) });
    layOut(h, { moved });
    const [withAge, without] = hostsOf(h);
    renderInto(h, withAge);
    renderInto(h, without, { ...entry(), OfficialRating: null, CommunityRating: null, CriticRating: null });
    h.settle();
    assert.ok(withAge.querySelector('.age-rating-tag'));
    assert.equal(withAge.dataset.jeFlow, undefined, what);
    assert.equal(without.dataset.jeFlow, '1', `${what}: a card the rule does not reach is not held back`);
    assert.equal(without.querySelector('.je-tag-slot[data-je-slot="br"]'), null);
    // The answer is remembered: drawing the cards again measures nothing.
    const asked = h.layout.flowStats().probes;
    h.layout.refreshPresentation();
    h.settle();
    assert.equal(h.layout.flowStats().probes, asked);
    assert.equal(withAge.dataset.jeFlow, undefined);
  }
});

test('a card that cannot be measured stays positioned until one of its kind can', t => {
  const h = setup(t, { html: card() + card(OTHER) });
  const [hidden, shown] = hostsOf(h);
  // In a tab that is not shown: no size, no boxes to compare.
  Object.defineProperty(hidden, 'clientWidth', { configurable: true, get: () => 0 });
  renderInto(h, hidden);
  h.settle();
  assert.equal(hidden.dataset.jeFlow, undefined);
  assert.equal(h.layout.flowStats().probes, 0);
  renderInto(h, shown);
  h.settle();
  assert.deepEqual([hidden.dataset.jeFlow, shown.dataset.jeFlow], ['1', '1'], 'the answer the shown card brought frees the hidden one too');
});

test('a quality or language group the page no longer clips keeps its card positioned', t => {
  const h = setup(t);
  // (Longhands: jsdom does not expand the overflow shorthand.)
  customCss(h, '.quality-overlay-container { overflow-x: visible !important; overflow-y: visible !important; }');
  h.render();
  assert.equal(h.flow(), undefined, 'flow would clip it again');
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

test('only the cards a layering rule reaches stay positioned, and the styles are read once per kind of element', async t => {
  const h = setup(t, { html: card() + card(OTHER) });
  const [withAge, without] = hostsOf(h);
  customCss(h, '.age-rating-tag { opacity: 0.9; }');
  renderInto(h, withAge);
  h.settle();
  const first = h.layout.flowStats().inspections;
  assert.ok(first > 0);
  renderInto(h, without, { ...entry(), OfficialRating: null });
  h.settle();
  assert.equal(withAge.dataset.jeFlow, undefined, 'its age rating chip is translucent');
  assert.equal(without.dataset.jeFlow, '1', 'no age rating chip on this card: nothing custom reaches it');
  // (The second card's bottom-right slot holds other things, so that slot and its rating group are a kind of their own.)
  const second = h.layout.flowStats().inspections;
  h.layout.refreshPresentation();
  h.settle();
  assert.equal(h.layout.flowStats().inspections, second, 'the same cards drawn again read nothing');
  // New settings (or a user switch) forget the answers: the page's CSS may have changed with them.
  await h.apply({});
  renderInto(h, withAge);
  h.settle();
  assert.ok(h.layout.flowStats().inspections > second);
});

test('a rule that tells one chip\'s part from another\'s, or one type of card from another, is seen', t => {
  // The critic chip's text is read first; the community chip's has the same tag and class.
  const parts = setup(t);
  customCss(parts, '.rating-tag-tmdb .rating-text { opacity: 0.6; }');
  parts.render();
  assert.ok(parts.host().querySelector('.rating-tag-tmdb .rating-text') && parts.host().querySelector('.rating-tag-critic .rating-text'));
  assert.equal(parts.flow(), undefined);

  const types = setup(t, { html: card() + card(OTHER).replace('data-type="Movie"', 'data-type="Series"') });
  customCss(types, '.card[data-type="Series"] .rating-tag { opacity: 0.8; }');
  const [movie, series] = hostsOf(types);
  renderInto(types, movie);
  types.settle();
  renderInto(types, series);
  types.settle();
  assert.deepEqual([movie.dataset.jeFlow, series.dataset.jeFlow], ['1', undefined]);
});

test('a style sheet that arrives after the cards were drawn is seen when a card is next placed, and every card is looked at again', t => {
  const h = setup(t, { html: card() + card(OTHER) });
  const [first, second] = hostsOf(h);
  renderInto(h, first);
  renderInto(h, second);
  h.settle();
  assert.deepEqual([first.dataset.jeFlow, second.dataset.jeFlow], ['1', '1']);
  customCss(h, '.quality-overlay-label { opacity: 0.85; } :root { --x: 1; }');
  // Any placement notices the new sheet; the other card is not touched by it.
  h.layout.commitGroup(first, 'language', h.flags(false));
  h.settle();
  assert.deepEqual([first.dataset.jeFlow, second.dataset.jeFlow], [undefined, undefined]);
  // And the switch is read again with it.
  const off = customCss(h, ':root { --je-tag-flow: off; }');
  h.document.documentElement.style.setProperty('--je-tag-flow', 'off');
  h.layout.commitGroup(first, 'language', h.flags(false));
  h.settle();
  off.remove();
  h.document.documentElement.style.removeProperty('--je-tag-flow');
  for (const style of h.document.head.querySelectorAll('style')) if (style.textContent.includes('opacity: 0.85')) style.remove();
  h.layout.commitGroup(first, 'language', h.flags(false));
  h.settle();
  assert.deepEqual([first.dataset.jeFlow, second.dataset.jeFlow], ['1', '1'], 'gone again: both rest in flow');
});

test('an element the fitting pass adds inside a group already inspected is inspected too', t => {
  const h = setup(t);
  customCss(h, '.je-tag-more { opacity: 0.8; }');
  h.render();
  assert.equal(h.flow(), '1');
  const more = h.document.createElement('span');
  more.className = 'je-tag-more';
  h.host().querySelector('.quality-overlay-container').appendChild(more);
  h.layout.commitGroup(h.host(), 'language', h.flags(false));
  assert.equal(h.flow(), undefined);
});
