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
async function open(page, settings) {
  await page.setViewportSize({ width: 900, height: 420 });
  await page.setContent(`<style>
    body { margin: 0; background: #223; font-family: sans-serif }
    .row { position: absolute; left: 20.796875px; top: 10.640625px; white-space: nowrap }
    .card { display: inline-block; width: 181.34375px; margin-right: 17.84375px; contain: content }
    .cardBox { container-type: inline-size }
    .cardScalable { position: relative; contain: layout style; height: 272.015625px }
    .cardImageContainer { position: absolute; inset: 0; border-radius: 8px; background: linear-gradient(135deg, #a63, #36a 60%, #3a6) }
    .je-tag-host { position: absolute !important; inset: 0; pointer-events: none }
    /* The icon font is not on this page: without it a genre icon is a long word that runs out of its circle and across the card's edge. */
    .je-msym-outlined { font-size: 0 !important }
    .status-tag { display: inline-flex; padding: 2.3px 7.3px; border-radius: 999px; background: rgba(0, 0, 0, .55); color: #fff; font-size: 11.3px; line-height: 1.3 }
    .custom-tag { display: inline-flex; padding: 2px 6.6px; border-radius: 4px; background: rgba(30, 60, 90, .8); color: #fff; font-size: 10.7px }
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
