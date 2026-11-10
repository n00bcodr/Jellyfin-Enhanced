const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { detectTagClipping } = require('./helpers/tag-clipping.cjs');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const english = require('../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json');

// Per-kind opacity and size (core/tag-layout.js kind looks), drawn by the real layout and tag stylesheets in the
// settings hub's preview: each kind changes alone, today's look is untouched at 100%, and mixed sizes in one stack
// or row stay fitted (no chip clipped, spilled, overlapping or off its card).

const FILES = ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js',
  'tags/tag-layout-styles.js', 'tags/rating-sources.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/qualitytags.js',
  'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/languagetags.js', 'tags/genretags.js',
  'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/settingspanel/ui-panel-tag-preview.js'];

const GROUPS_ON = { statusTagsEnabled: true, statusTagsTrending: true, qualityTagsEnabled: true, ratingTagsEnabled: true,
  languageTagsEnabled: true, languageTagsStyle: 'codes', languageTagsShowSubtitles: true, genreTagsEnabled: true, ageRatingTagsEnabled: true };

/** Clearly different looks for several kinds at once, at the ends of both ranges. */
const MIXED = [
  { kind: 'resolution', scale: 200 }, { kind: 'audio', opacity: 50 }, { kind: 'language', opacity: 60, scale: 150 },
  { kind: 'rating', opacity: 40, scale: 70 }, { kind: 'status', scale: 180 }, { kind: 'genre', scale: 50 }, { kind: 'ageRating', opacity: 10 },
];

async function setup(page, width = 262) {
  await page.setContent(`<style>body{margin:0;padding:8px;font-family:Arial,sans-serif;background:#111;color:#fff}*,*::before,*::after{transition:none!important}</style><div id="jellyfin-enhanced-panel"><div id="preview" style="width:${width}px"></div></div>`);
  await page.evaluate(({ english, settings }) => {
    window.JellyfinEnhanced = { core: {}, helpers: {}, pluginConfig: {}, currentSettings: { tagLayoutSettingsVersion: 1, ...settings },
      t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), english[key] || key),
      tagPipeline: { registerRenderer() {}, clearProcessed() {}, scheduleScan() {} } };
  }, { english, settings: GROUPS_ON });
  for (const file of FILES) await page.addScriptTag({ path: path.join(root, file) });
  await page.evaluate(() => {
    window.preview = window.JellyfinEnhanced.internals.enhancedUi.createTagPreview(document.querySelector('#preview'), {});
  });
  await page.mouse.move(0, 0);
}

/** Redraw with these settings and settle the fitting pass. */
async function draw(page, settings) {
  await page.evaluate(async (settings) => {
    const JE = window.JellyfinEnhanced;
    Object.assign(JE.currentSettings, settings);
    window.preview.refresh();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    JE.core.tagLayout.flushFit();
    document.querySelectorAll('.je-mtp-card').forEach((card) => card.classList.toggle('je-tag-reveal', !!settings.hover));
  }, settings);
}

/** The first poster sample's chips: kind, rendered font size, opacity and box. */
function chipsOf(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.je-mtp-card');
    const read = (el, kind) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // A kind's opacity is a filter over the chip's own opacity.
      const filtered = /opacity\(([\d.]+)\)/.exec(s.filter);
      return { kind, fontSize: parseFloat(s.fontSize), opacity: Number(s.opacity) * (filtered ? Number(filtered[1]) : 1), w: r.width, h: r.height, x: r.left, y: r.top };
    };
    const out = [];
    card.querySelectorAll('.je-tag-slot:not([data-je-slot="hover"]) [data-je-group="quality"] > .quality-overlay-label').forEach((el) => out.push(read(el, el.dataset.jeTagKind)));
    for (const group of ['rating', 'language', 'status', 'ageRating', 'genre']) {
      card.querySelectorAll(`.je-tag-slot:not([data-je-slot="hover"]) [data-je-group="${group}"] > *`).forEach((el) => out.push(read(el, group)));
    }
    return out;
  });
}

test('each kind takes its own size and opacity; every other kind keeps today\'s look', async ({ page }) => {
  await setup(page);
  await draw(page, { tagLayout: 'corners', tagScale: 'default', tagKindLooks: null });
  const before = await chipsOf(page);
  const kinds = new Set(before.map((c) => c.kind));
  for (const kind of ['resolution', 'videoCodec', 'rating', 'language']) expect(kinds.has(kind), `${kind} drawn: ${[...kinds]}`).toBe(true);

  await draw(page, { tagKindLooks: [{ kind: 'resolution', scale: 150 }, { kind: 'language', opacity: 50 }] });
  const after = await chipsOf(page);
  expect(after.length).toBe(before.length);
  after.forEach((chip, i) => {
    const was = before[i];
    expect(chip.kind).toBe(was.kind);
    if (chip.kind === 'resolution') {
      expect(chip.fontSize).toBeCloseTo(was.fontSize * 1.5, 0);
      expect(chip.opacity).toBe(1);
    } else if (chip.kind === 'language') {
      expect(chip.opacity).toBeCloseTo(0.5, 2);
      expect(chip.fontSize).toBe(was.fontSize);
      expect(chip.w).toBeCloseTo(was.w, 0);
    } else {
      expect({ kind: chip.kind, fontSize: chip.fontSize, opacity: chip.opacity }).toEqual({ kind: was.kind, fontSize: was.fontSize, opacity: was.opacity });
      // Same box (a neighbour's new size may move sub-pixel rounding by a few hundred-thousandths of a pixel).
      expect(chip.w).toBeCloseTo(was.w, 1);
      expect(chip.h).toBeCloseTo(was.h, 1);
    }
  });

  // Every kind explicitly at 100%: exactly today's chips, and no marker or rule.
  await draw(page, { tagKindLooks: [{ kind: 'resolution', opacity: 100, scale: 100 }, { kind: 'language', opacity: 100, scale: 100 }] });
  expect(await chipsOf(page)).toEqual(before);
  expect(await page.locator('[data-je-kind-looks]').count()).toBe(0);
});

test('the card\'s tag size and a kind\'s size multiply', async ({ page }) => {
  await setup(page);
  await draw(page, { tagLayout: 'corners', tagScale: 'largest', tagKindLooks: null });
  const largest = (await chipsOf(page)).find((c) => c.kind === 'resolution');
  await draw(page, { tagKindLooks: [{ kind: 'resolution', scale: 50 }] });
  const half = (await chipsOf(page)).find((c) => c.kind === 'resolution');
  expect(half.fontSize).toBeCloseTo(largest.fontSize / 2, 0);
});

/** Everyday values: up to 150% and down to 70%, with several opacities. */
const MILD = [{ kind: 'resolution', scale: 150 }, { kind: 'audio', opacity: 50 }, { kind: 'language', opacity: 60, scale: 130 },
  { kind: 'rating', opacity: 40, scale: 80 }, { kind: 'status', scale: 150 }, { kind: 'genre', scale: 70 }];

// As in tag-clipping.spec.cjs: Corners' four corner stacks keep the geometry tags had before layouts and are not
// fitted against each other, so with every group on they may meet; everything else is fitted.
const LEGACY_STACK = new Set(['tl', 'tr', 'bl', 'br']);
const LEGACY_TYPES = ['slot-overlap', 'ancestor-clip', 'outside-card', 'container-trim'];

/** Every finding of one layout over these settings (resting and on hover). */
async function findings(page, layout, looks, scales) {
  const all = [];
  for (const tagScale of scales) {
    for (const hover of [false, true]) {
      await draw(page, { tagLayout: layout, tagScale, tagLabelDensity: 'full', tagKindLooks: looks, hover });
      const r = await page.evaluate(detectTagClipping, { root: '.je-mtp' });
      expect(r.chips).toBeGreaterThan(0);
      all.push(...r.findings.map((f) => ({ conf: `${layout}/${tagScale}/${hover ? 'hover' : 'rest'}`, legacy: layout === 'corners' && LEGACY_STACK.has(f.slot) && (!f.other || LEGACY_STACK.has(f.other.slot)), ...f })));
    }
  }
  return all;
}

for (const layout of ['corners', 'bands', 'caption', 'summary', 'minimal']) {
  test(`${layout}: everyday mixed kind sizes stay fitted, as at 100%`, async ({ page }) => {
    test.setTimeout(60000);
    await setup(page);
    const all = await findings(page, layout, MILD, ['default']);
    expect(all.filter((f) => !f.legacy).slice(0, 8)).toEqual([]);
    expect(all.filter((f) => f.legacy && !LEGACY_TYPES.includes(f.type))).toEqual([]);
  });

  test(`${layout}: extreme kind sizes never overlap another chip or leave the card`, async ({ page }) => {
    test.setTimeout(60000);
    await setup(page);
    const all = await findings(page, layout, MIXED, ['default', 'largest']);
    // A chip made wider than the whole card (200% on top of the largest Tag size on a 126px poster) is held to the
    // card's width and its label is cut inside its own box; nothing else may happen.
    const cut = (f) => f.type === 'text-overflow';
    expect(all.filter((f) => !f.legacy && !cut(f)).slice(0, 8)).toEqual([]);
    expect(all.filter((f) => f.legacy && !LEGACY_TYPES.includes(f.type) && !cut(f))).toEqual([]);
  });
}
