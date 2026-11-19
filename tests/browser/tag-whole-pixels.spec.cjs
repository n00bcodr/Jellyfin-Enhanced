const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');

// The seven group containers used to have layout and style containment, which makes Chromium paint a box
// from a whole pixel. They no longer have it: the layout controller moves each container by the fraction
// of a pixel it is off instead (core/tag-layout.js flushSnap). These cases prove, in a real browser, that
// a card then paints exactly the pixels it painted with contained containers, on cards that sit between
// pixels the way Jellyfin's do.

const CONTAINED = ':is(.genre-overlay-container,.quality-overlay-container,.language-overlay-container,.rating-overlay-container,.age-rating-overlay-container,.status-overlay-container,.logo-overlay-container)';
const ID = n => String(n).repeat(32);
const card = n => `<div class="card" data-id="${ID(n)}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div></div></div>`;

/**
 * Three cards at fractional offsets, as in a row of Jellyfin's, with the real renderers and layout controller.
 * (The row is not a compositor layer of its own here, as Jellyfin's sliding rows are. In one that sits between
 * pixels the browser may raster contained containers apart from the rest and resample each on its own, which
 * changes pixels where translucent things overlap, whatever the containers' positions: that is the
 * compositor's doing, and not what this pins.)
 */
async function open(page, settings, css = '', sized = true) {
  if (sized) await page.setViewportSize({ width: 900, height: 420 });
  await page.setContent(`<style>
    body { margin: 0; background: #223; font-family: sans-serif }
    .row { position: absolute; left: 20.796875px; top: 10.640625px; white-space: nowrap }
    .card { display: inline-block; width: 181.34375px; margin-right: 17.84375px; contain: content }
    .cardBox { container-type: inline-size }
    .cardScalable { position: relative; contain: layout style; height: 272.015625px }
    /* Square artwork. (Where a chip's shadow reaches an anti-aliased rounded corner of the artwork, Chromium
       rasters those few pixels differently from one run to the next, however the containers are placed.) */
    .cardImageContainer { position: absolute; inset: 0; background: linear-gradient(135deg, #a63, #36a 60%, #3a6) }
    .je-tag-host { position: absolute !important; inset: 0; pointer-events: none }
    /* The icon font is not on this page: without it a genre icon is a long word that runs out of its circle and across the card's edge. */
    .je-msym-outlined { font-size: 0 !important }
    .status-tag { display: inline-flex; padding: 2.3px 7.3px; border-radius: 999px; background: rgba(0, 0, 0, .55); color: #fff; font-size: 11.3px; line-height: 1.3 }
    .custom-tag { display: inline-flex; padding: 2px 6.6px; border-radius: 4px; background: rgba(30, 60, 90, .8); color: #fff; font-size: 10.7px }
    ${css}
    </style><div class="row">${[1, 2, 3].map(card).join('')}</div>`);
  await page.evaluate((settings) => {
    window.JellyfinEnhanced = {
      currentSettings: { qualityTagsEnabled: true, genreTagsEnabled: true, ratingTagsEnabled: true, ageRatingTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', tagLayoutSettingsVersion: 1, ...settings },
      pluginConfig: { TagCacheServerMode: true }, t: k => k,
      cdn: { flagSvg: () => 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E' },
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { renderers: {}, registerRenderer(name, renderer) { this.renderers[name] = renderer; }, getRenderer(name) { return this.renderers[name]; }, clearProcessed() {}, scheduleScan() {},
        peekReviewRatings: () => null, getReviewRatingsRequestedAt: () => 1, getReviewRatings: async () => null, onReviewRatingsChanged() {} },
    };
  }, settings);
  for (const f of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/rating-sources.js',
    'tags/qualitytags.js', 'tags/genretags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js']) await page.addScriptTag({ path: path.join(root, f) });
  await page.evaluate(() => {
    const JE = JellyfinEnhanced;
    JE.initializeQualityTags(); JE.initializeGenreTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags();
    for (const renderer of Object.values(JE.tagPipeline.renderers)) renderer.injectCss?.();
    /** Draw every card's tags: what the tag renderers make, a status badge and a custom tag (which never was contained). */
    window.draw = () => {
      document.querySelectorAll('.je-tag-host').forEach((host, i) => {
        const id = host.closest('.card').dataset.id;
        const entry = { Type: 'Movie', TmdbId: '42', Genres: ['Drama', 'Crime'].slice(0, 1 + (i % 2)), CommunityRating: 7.4 + i / 10, CriticRating: 88 + i, OfficialRating: ['PG-13', 'R', 'TV-MA'][i], AudioLanguages: ['en'],
          StreamData: { Streams: [{ Type: 'Video', Codec: 'hevc', Height: 2160, DisplayTitle: '4K HEVC' }], Sources: [{ Path: 'Movie (2020).mkv', Name: 'Movie (2020)' }], ItemName: 'Movie', ItemPath: 'Movie (2020).mkv' } };
        for (const renderer of Object.values(JE.tagPipeline.renderers)) if (renderer.isEnabled() && renderer.renderFromServerCache) renderer.renderFromServerCache(host, entry, id);
        const make = (cls, chip, text) => { const el = document.createElement('div'); el.className = cls; el.innerHTML = `<div class="${chip}">${text}</div>`; return el; };
        JE.core.tagLayout.commitGroup(host, 'status', make('status-overlay-container', 'status-tag', ['New Season', 'Ended', 'Returning'][i]));
        JE.core.tagLayout.commitGroup(host, 'custom', make('custom-overlay-container', 'custom-tag', 'Director\'s cut'.slice(0, 8 + i * 3)));
      });
    };
    window.draw();
  });
  await settled(page);
}

/** Every pass has run: the fit, the resting layout (idle) and the whole-pixel pass, and the frames after them are painted. */
async function settled(page) {
  await page.waitForFunction(() => {
    const L = JellyfinEnhanced.core.tagLayout;
    return document.querySelectorAll('.je-tag-host').length === document.querySelectorAll('.je-tag-host[data-je-flow]').length && L.snapStats().waiting === 0;
  }, null, { timeout: 10000 });
  await page.evaluate(() => new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 150))), 250)));
}

/** How far each contained container's corner is from a whole pixel of its image box's grid, for those that are off. */
const offGrid = page => page.evaluate((contained) => {
  const scale = JellyfinEnhanced.core.tagLayout.snapStats().scale || 1;
  const out = [];
  for (const el of document.querySelectorAll(`.je-tag-host > .je-tag-slot > ${contained}`)) {
    const r = el.getBoundingClientRect(), o = el.closest('.cardScalable').getBoundingClientRect();
    if (!(r.width > 0)) continue;
    const off = Math.max(...[r.left - o.left, r.top - o.top].map(v => Math.abs(v * scale - Math.round(v * scale))));
    out.push({ group: el.dataset.jeGroup, slot: el.parentElement.dataset.jeSlot, off: +off.toFixed(4) });
  }
  return out;
}, CONTAINED);

const shot = page => page.screenshot({ clip: { x: 0, y: 0, width: 640, height: 300 }, animations: 'disabled', caret: 'hide' });

/** The card as it was painted before: every container contained, none nudged. */
async function contained(page, on) {
  await page.evaluate(() => { const L = JellyfinEnhanced.core.tagLayout; L.wholePixels = false; L.refreshPresentation(); window.draw(); });
  await page.evaluate(([on, rule]) => { document.getElementById('was')?.remove(); if (on) { const style = document.createElement('style'); style.id = 'was'; style.textContent = rule; document.head.appendChild(style); } },
    [on, `.je-tag-host ${CONTAINED} { contain: layout style }`]);
  await settled(page);
}

for (const [name, settings] of [['Corners', {}], ['Corners, Tight edge and larger tags', { tagEdgeSpacing: 'tight', tagScale: 'larger', tagGap: 'roomy' }], ['Bands', { tagLayout: 'bands' }], ['Caption', { tagLayout: 'caption' }]]) {
  test(`${name}: a card paints the pixels it painted when its group containers were contained`, async ({ page, browserName }, info) => {
    test.setTimeout(60000);
    await open(page, settings);
    const chromium = browserName === 'chromium';
    const before = await offGrid(page);
    expect(before.length).toBeGreaterThan(0);
    const nudged = await page.evaluate(() => [...document.querySelectorAll('.je-tag-host [data-je-group]')].filter(el => el.style.getPropertyValue('--je-snap-x') || el.style.getPropertyValue('--je-snap-y')).length);
    if (chromium) {
      // Chromium's family: every container that was contained lies on whole pixels of its image box's grid.
      expect(before.filter(c => c.off > 0.001)).toEqual([]);
      expect(nudged).toBeGreaterThan(0);
    } else {
      // Firefox paints a contained box where it paints a plain one: nothing is moved.
      expect(nudged).toBe(0);
    }
    const now = await shot(page);
    await contained(page, true);
    if (chromium) expect((await offGrid(page)).filter(c => c.off > 0.001).length, 'the cards do sit between pixels').toBeGreaterThan(0);
    const was = await shot(page);
    await info.attach('now.png', { body: now, contentType: 'image/png' });
    await info.attach('contained.png', { body: was, contentType: 'image/png' });
    expect(now.equals(was), 'the same pixels as with contained containers').toBe(true);
    // And the nudge is what makes it so: neither contained nor nudged, Chromium paints the chips a fraction of a pixel off
    // (seen on the corner stacks, which are aligned to the right and bottom edges of a card of fractional size).
    if (chromium && info.project.name === 'chromium' && name.startsWith('Corners')) {
      await contained(page, false);
      expect((await shot(page)).equals(was)).toBe(false);
    }
  });
}

// The pixel grid a card's containers are snapped to starts at the nearest box that starts one (Jellyfin's image
// box does). Where a theme takes that box's containment away, the grid starts further up, and a box in between
// that is moved by a fraction of a pixel moves the grid with it: by `transform`, or by `translate`, which is not
// part of the computed transform. A `scale` or `rotate` that changes nothing starts no grid of its own.
// (At one device pixel to a CSS pixel only. Under an emulated ratio a box moved by a fraction is rastered through
// one more transform when it is contained, and a handful of anti-aliased pixels in a million come out a level
// apart wherever a plain box is put: 9 here with the nudge, 44,000 without it.)
for (const [name, css] of [
  ['transform: translate()', '.cardBox { transform: translate(0.296875px, 0.703125px) }'],
  ['translate', '.cardBox { translate: 0.296875px 0.703125px }'],
  ['translate and transform together', '.cardBox { translate: 0.296875px 0.203125px; transform: translateY(0.5px) }'],
  ['scale: 1', '.cardBox { scale: 1 }'],
  ['rotate: 0deg', '.cardBox { rotate: 0deg }'],
]) {
  test(`a card whose pixel grid starts above a box moved by ${name} paints the pixels it painted contained`, async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium', 'pixel for pixel at a device scale of 1; nothing is nudged outside Chromium\'s family');
    test.setTimeout(60000);
    // (The moved box itself sits a fraction of a pixel into the card, so a grid started at it is not the card's.)
    await open(page, {}, `.cardScalable { contain: none } .cardBox { margin: 0.390625px 0 0 0.296875px } ${css}`);
    const now = await shot(page);
    await contained(page, true);
    const was = await shot(page);
    await info.attach('now.png', { body: now, contentType: 'image/png' });
    await info.attach('contained.png', { body: was, contentType: 'image/png' });
    expect(now.equals(was), 'the same pixels as with contained containers').toBe(true);
    await contained(page, false);
    expect((await shot(page)).equals(was), 'and the nudge is what makes it so').toBe(false);
  });
}

// A screen of more than one device pixel to a CSS pixel (and a zoomed page) lays out and snaps in device pixels:
// the grid is finer than a CSS pixel, and a nudge is a fraction of a device pixel. A device scale the test
// runner emulates does not do that (it snaps in CSS pixels, which the mobile project covers), so these launch a
// browser with a real one.
for (const [scale, name, settings] of [[1.25, 'Corners', {}], [1.25, 'Bands', { tagLayout: 'bands' }], [1.5, 'Bands', { tagLayout: 'bands' }], [1.5, 'Caption', { tagLayout: 'caption' }],
  [2, 'Corners, Tight edge and larger tags', { tagEdgeSpacing: 'tight', tagScale: 'larger' }]]) {
  test(`${name} at a real device scale of ${scale}: containers lie on whole device pixels and paint what they painted contained`, async ({ playwright }, info) => {
    test.skip(info.project.name !== 'chromium', 'one browser of Chromium\'s family is enough');
    test.setTimeout(90000);
    const browser = await playwright.chromium.launch({ ...info.project.use.launchOptions, args: [`--force-device-scale-factor=${scale}`, '--window-size=900,420'] });
    try {
      // (No viewport and no ratio of the runner's: either would be an emulated one.)
      const page = await (await browser.newContext({ viewport: null, deviceScaleFactor: undefined })).newPage();
      await open(page, settings, '', false);
      expect(await page.evaluate(() => JellyfinEnhanced.core.tagLayout.snapStats().scale)).toBe(scale);
      const nudges = await page.evaluate(() => [...document.querySelectorAll('.je-tag-host [data-je-group]')].flatMap(el => ['--je-snap-x', '--je-snap-y'].map(name => parseFloat(el.style.getPropertyValue(name)) || 0)).filter(Boolean));
      expect(nudges.length).toBeGreaterThan(0);
      // Each is a whole number of layout units (64ths of a device pixel), and at most half a device pixel.
      for (const value of nudges) {
        expect(Math.abs(value * scale * 64 - Math.round(value * scale * 64))).toBeLessThan(1e-6);
        expect(Math.abs(value * scale)).toBeLessThanOrEqual(0.5);
      }
      expect((await offGrid(page)).filter(c => c.off > 0.001)).toEqual([]);
      const now = await shot(page);
      await contained(page, true);
      expect((await offGrid(page)).filter(c => c.off > 0.001).length, 'the cards do sit between device pixels').toBeGreaterThan(0);
      const was = await shot(page);
      await info.attach('now.png', { body: now, contentType: 'image/png' });
      await info.attach('contained.png', { body: was, contentType: 'image/png' });
      expect(now.equals(was), 'the same pixels as with contained containers').toBe(true);
    } finally {
      await browser.close();
    }
  });
}

// Bands' top band wraps whole groups. A group pushed from its right is that much narrower when the browser
// breaks the band into lines, so a nudge could pull a group that only just wrapped back up onto the line
// above: the band would change height, the nudge would come off, the group would go down again, and so on.
test('Bands: a group that only just wraps onto the band\'s second line stays there, and the page comes to rest', async ({ page, browserName }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1200, height: 900 });
  const sheet = `<style>
    body { margin: 0; background: #223; font-family: sans-serif }
    #cards { position: absolute; left: 10.3px; top: 10.7px; width: 1150px }
    .card { display: inline-block; margin: 0 6.3px 6.3px 0; contain: content }
    .cardBox { container-type: inline-size }
    .cardScalable { position: relative; contain: layout style; height: 120px }
    .cardImageContainer { position: absolute; inset: 0; background: #456 }
    .je-tag-host { position: absolute !important; inset: 0; pointer-events: none }
    .status-tag { display: inline-flex; padding: 2.3px 7.3px; border-radius: 999px; background: rgba(0, 0, 0, .55); color: #fff; font-size: 11.3px; line-height: 1.3; white-space: nowrap }
    </style><div id="cards"></div>`;
  await page.setContent(sheet);
  await page.evaluate(() => {
    window.JellyfinEnhanced = {
      currentSettings: { ageRatingTagsEnabled: true, tagLayoutSettingsVersion: 1, tagLayout: 'bands',
        tagLayouts: { bands: { groups: [{ group: 'status', slot: 'top' }, { group: 'ageRating', slot: 'top' }] } } },
      pluginConfig: { TagCacheServerMode: true }, t: k => k,
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { renderers: {}, registerRenderer(name, renderer) { this.renderers[name] = renderer; }, getRenderer(name) { return this.renderers[name]; }, clearProcessed() {}, scheduleScan() {} },
    };
  });
  for (const f of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/ageratingtags.js']) await page.addScriptTag({ path: path.join(root, f) });
  await page.evaluate(() => {
    const JE = JellyfinEnhanced;
    JE.initializeAgeRatingTags();
    for (const renderer of Object.values(JE.tagPipeline.renderers)) renderer.injectCss?.();
    /** Cards of the given widths, each with a status badge and an age rating in its top band. */
    window.cards = (widths) => {
      const box = document.getElementById('cards');
      box.innerHTML = widths.map((w, i) => `<div class="card" style="width:${w}px" data-id="${String(i).padStart(32, '0')}" data-type="Series"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div></div></div>`).join('');
      box.querySelectorAll('.je-tag-host').forEach((host) => {
        const status = document.createElement('div');
        status.className = 'status-overlay-container';
        status.innerHTML = '<div class="status-tag">Returning Series</div>';
        JE.core.tagLayout.commitGroup(host, 'status', status);
        for (const renderer of Object.values(JE.tagPipeline.renderers)) if (renderer.isEnabled() && renderer.renderFromServerCache) renderer.renderFromServerCache(host, { Type: 'Series', OfficialRating: 'TV-MA' }, host.closest('.card').dataset.id);
      });
    };
    /** How many lines each card's top band has, from its groups' tops. */
    window.lines = () => [...document.querySelectorAll('.je-tag-slot[data-je-slot="top"]')].map((slot) => new Set([...slot.children].map((g) => Math.round(g.getBoundingClientRect().top))).size);
  });
  const rest = async () => {
    await page.waitForFunction(() => document.querySelectorAll('.je-tag-host').length === document.querySelectorAll('.je-tag-host[data-je-flow]').length && JellyfinEnhanced.core.tagLayout.snapStats().waiting === 0, null, { timeout: 10000 });
    await page.evaluate(() => new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 400)));
  };
  // Without nudges first: the card width at which the age rating comes up beside the badge (chips scale with the
  // card, so it is found by laying cards out), then eighty cards from just under half a pixel short of it to a
  // quarter of a pixel past it, a hundredth of a pixel apart.
  await page.evaluate(() => { JellyfinEnhanced.core.tagLayout.wholePixels = false; });
  const coarse = Array.from({ length: 320 }, (_, k) => 140 + k * 0.25);
  await page.evaluate((widths) => window.cards(widths), coarse);
  await rest();
  const turn = coarse[(await page.evaluate(() => window.lines())).lastIndexOf(2)];
  expect(turn).toBeGreaterThan(141);
  expect(turn).toBeLessThan(219);
  const widths = Array.from({ length: 80 }, (_, k) => +(turn - 0.55 + k * 0.01).toFixed(3));
  await page.evaluate((widths) => window.cards(widths), widths);
  await rest();
  const bare = await page.evaluate(() => window.lines());
  expect(bare.filter(n => n === 2).length, 'cards whose age rating only just wraps').toBeGreaterThan(40);
  expect(bare.filter(n => n === 1).length, 'and cards where it only just fits').toBeGreaterThan(0);
  // With whole pixels on, every band has the lines it had, and nothing keeps being measured.
  await page.evaluate((widths) => { JellyfinEnhanced.core.tagLayout.wholePixels = true; window.cards(widths); }, widths);
  await rest();
  const sizes = await page.evaluate(() => new Promise((resolve) => {
    // Any band that changes size from here on is a band that has not come to rest.
    let changes = -document.querySelectorAll('.je-tag-slot[data-je-slot="top"]').length;
    const watch = new ResizeObserver((entries) => { changes += entries.length; });
    document.querySelectorAll('.je-tag-slot[data-je-slot="top"]').forEach(slot => watch.observe(slot));
    const before = JellyfinEnhanced.core.tagLayout.snapStats().passes;
    setTimeout(() => { watch.disconnect(); resolve({ changes, passes: JellyfinEnhanced.core.tagLayout.snapStats().passes - before, lines: window.lines() }); }, 1500);
  }));
  expect(sizes.lines).toEqual(bare);
  expect(sizes.changes).toBe(0);
  expect(sizes.passes).toBe(0);
  if (browserName === 'chromium') {
    const nudged = await page.evaluate(() => document.querySelectorAll('.je-tag-host [style*="--je-snap"]').length);
    expect(nudged).toBeGreaterThan(0);
  }
});
