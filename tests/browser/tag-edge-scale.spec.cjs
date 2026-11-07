const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
for (const edge of ['tight', 'flush']) for (const [scale, gap, size, spacing] of [['smaller', 'tight', .85, .75], ['largest', 'roomy', 1.3, 1.5]]) {
  test(`Corners ${edge} with ${scale}/${gap}: nine anchors and indicator/progress clearance`, async ({ page }) => {
    test.setTimeout(45000);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.setContent(`<style>
      .card { width:180px } .cardBox { container-type:inline-size }
      .cardScalable { position:relative; width:180px; height:270px }
      .cardImageContainer { position:absolute; inset:0; border-radius:8px }
      .je-tag-host { position:absolute!important; inset:0; pointer-events:none }
      .countIndicator { position:absolute; right:0; top:0; width:24px; height:24px }
      .itemProgressBar { position:absolute; left:0; right:0; bottom:0; height:4px }
      </style><div class="card" data-id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="countIndicator"></div><div class="itemProgressBar"></div><div class="je-tag-host"></div></div></div></div>`);
    await page.evaluate(({ edge, scale, gap }) => {
      window.JellyfinEnhanced = { currentSettings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', tagLayoutSettingsVersion: 1,
        tagEdgeSpacing: edge, tagScale: scale, tagGap: gap, tagLayout: 'corners' }, pluginConfig: {}, t: k => k,
        tagPipeline: { registerRenderer(name, renderer) { this[name] = renderer; }, clearProcessed() {}, scheduleScan() {} } };
    }, { edge, scale, gap });
    for (const f of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/qualitytags.js']) await page.addScriptTag({ path: path.join(root, f) });
    const rows = await page.evaluate(async () => {
      const JE = JellyfinEnhanced, L = JE.core.tagLayout;
      JE.initializeQualityTags(); JE.tagPipeline.quality.injectCss();
      const host = document.querySelector('.je-tag-host');
      JE.tagPipeline.quality.renderFromServerCache(host, { Type: 'Movie', StreamData: { Streams: [{ Type: 'Video', Codec: 'hevc', Height: 2160 }], Sources: [], ItemName: 'Movie' } }, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const rows = [];
      for (const slot of ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br']) {
        JE.currentSettings.tagLayouts = { corners: { groups: [{ group: 'quality', slot }] } };
        await JE.reinitializeTagLayout();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        L.flushFit();
        const el = host.querySelector(`[data-je-slot="${slot}"]`), chip = el.querySelector('.quality-overlay-label');
        const c = chip.getBoundingClientRect(), h = host.getBoundingClientRect(), st = getComputedStyle(el);
        rows.push({ slot, left: c.left - h.left, right: h.right - c.right, top: c.top - h.top, bottom: h.bottom - c.bottom,
          gap: parseFloat(st.gap), font: parseFloat(getComputedStyle(chip).fontSize), inset: parseFloat(st.left),
          progressBottom: parseFloat(el.style.getPropertyValue('--je-anchor-bottom')), clipped: getComputedStyle(host).overflow, radius: getComputedStyle(host).borderRadius });
      }
      return rows;
    });
    const inset = edge === 'tight' ? 3 : 0;
    for (const r of rows) {
      expect(r.gap).toBeCloseTo(4 * size * spacing, 2);
      expect(r.font).toBeGreaterThan(0);
      if (['tl', 'ml', 'bl'].includes(r.slot)) expect(r.left).toBeCloseTo(inset, 1);
      if (['tr', 'mr', 'br'].includes(r.slot)) expect(r.right).toBeCloseTo(inset, 1);
      if (['tl', 'tc'].includes(r.slot)) expect(r.top).toBeCloseTo(inset, 1);
      if (r.slot === 'tr') expect(r.top).toBeCloseTo(inset + 30 * size, 1);
      if (r.slot === 'bc') expect(r.progressBottom).toBeCloseTo(edge === 'flush' ? 4 : Math.max(inset, 4 + 4 * size * spacing), 1);
      if (edge === 'flush') { expect(r.clipped).toBe('hidden'); expect(r.radius).toBe('8px'); }
    }
  });
}
