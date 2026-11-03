const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const en = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json')));

/**
 * Production Awards (ml) opposite production Status (mr) on a 12vw Corners
 * card inside a view Jellyfin can hide with display:none and keep cached.
 */
async function setup(page) {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/');
  await page.setContent(`<style>
    @font-face { font-family:'JE Material Symbols Outlined'; src:url('/Jellyfin.Plugin.JellyfinEnhanced/js/fonts/materialsymbolsoutlined-subset.woff2') }
    body { margin:0 } #view.hide { display:none }
    #wrap { width:100% }
    .cardBox { container-type:inline-size; width:12vw }
    .cardScalable { position:relative; width:12vw; aspect-ratio:2/3 }
    .cardImageContainer { position:absolute; inset:0; border-radius:8px }
    .je-tag-host { position:absolute!important; inset:0 }
  </style><div id="view"><div id="wrap"><div class="card" data-type="Movie"><div class="cardBox"><div class="cardScalable"><a class="cardImageContainer" href="#/details?id=0123456789abcdef0123456789abcdef"></a><div class="je-tag-host"></div></div><div class="cardText">Fixture</div></div></div></div></div>`);
  await page.evaluate(en => {
    window.JellyfinEnhanced = { pluginConfig:{}, currentSettings:{tagLayoutSettingsVersion:1,tagLayout:'corners',
      statusTagsEnabled:true,statusTagsShowJustAdded:true,statusTagsJustAddedDays:30,
      tagLayouts:{corners:{groups:[{group:'awards',slot:'ml'},{group:'status',slot:'mr'}]}}},
      t:key=>en[key] || key, tagPipeline:{registerRenderer(name, renderer){ this[name]=renderer; renderer.injectCss?.(); },clearProcessed(){},scheduleScan(){}} };
  }, en);
  for (const file of ['core/ui-kit.js','core/dom-observer.js','core/tag-renderer-base.js','core/tag-layout.js','tags/tag-layout-styles.js',
    'tags/tag-styles.js','tags/status-vocabulary.js','tags/statustags.js','tags/awardstags.js']) await page.addScriptTag({path:path.join(root,file)});
  await page.evaluate(async () => {
    const JE=JellyfinEnhanced,h=document.querySelector('.je-tag-host');
    JE.initializeStatusTags(); JE.initializeAwardsTags(); JE.core.tagLayout.invalidateSettings();
    JE.tagPipeline.awards.renderFromServerCache(h,{Awards:{CertifiedFresh:true}});
    JE.tagPipeline.status.renderFromServerCache(h,{Type:'Movie',DateCreated:new Date().toISOString()});
  });
  await frames(page);
}

/** Let the page run a few frames (ResizeObserver callbacks, then the queued fitting pass). */
async function frames(page, n = 4) {
  await page.evaluate(n => new Promise(r => { const step = k => k ? requestAnimationFrame(() => step(k - 1)) : setTimeout(r, 0); step(n); }), n);
}

/** Card width, the Awards budget and how far Awards overlaps the Status chip. */
function measure(page) {
  return page.evaluate(() => {
    const h=document.querySelector('.je-tag-host'),c=h.querySelector('.awards-tag'),a=c.parentElement;
    return {card:Math.round(h.getBoundingClientRect().width),budget:a.style.getPropertyValue('--je-chip-fit-width'),
      overlap:Math.round(c.getBoundingClientRect().right-h.querySelector('.status-tag').getBoundingClientRect().left)};
  });
}

/** What a fresh fit at the current size gives. */
async function fresh(page) {
  await page.evaluate(() => { const L=JellyfinEnhanced.core.tagLayout;L.refreshPresentation(document.querySelector('.je-tag-host'));L.flushFit(); });
  return measure(page);
}

test('a cached view shown again after a resize refits its cards', async ({ page }) => {
  await setup(page);
  const wide = await measure(page);
  expect(wide.card).toBe(168);
  expect(wide.overlap).toBeLessThan(0);
  await page.evaluate(() => document.getElementById('view').classList.add('hide'));
  await frames(page);
  await page.setViewportSize({ width: 700, height: 800 });
  await frames(page);
  await page.evaluate(() => document.getElementById('view').classList.remove('hide'));
  await frames(page);
  const shown = await measure(page);
  expect(shown.card).toBe(84);
  expect(shown.budget).not.toBe(wide.budget);
  expect(shown.overlap).toBeLessThan(0);
  expect(shown).toEqual(await fresh(page));
});

test('a card width change without a window resize refits the card, then settles', async ({ page }) => {
  await setup(page);
  const wide = await measure(page);
  await page.evaluate(() => { document.getElementById('wrap').style.width='50%';
    for (const el of document.querySelectorAll('.cardBox, .cardScalable')) el.style.width='6vw'; });
  await frames(page);
  const narrow = await measure(page);
  expect(narrow.card).toBe(84);
  expect(narrow.budget).not.toBe(wide.budget);
  expect(narrow.overlap).toBeLessThan(0);
  // The fit's own writes never re-trigger it: nothing is queued once it settled.
  const settled = await page.evaluate(async () => {
    const host=document.querySelector('.je-tag-host'),before=host.innerHTML;
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    return host.innerHTML===before;
  });
  expect(settled).toBe(true);
  expect(narrow).toEqual(await fresh(page));
});

test('legacy cards that never needed a fit are not watched', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div class="card"><div class="cardBox"><div class="cardScalable" style="position:relative;width:180px;height:270px"><div class="je-tag-host"></div></div></div></div>');
  await page.evaluate(en => {
    window.JellyfinEnhanced = { pluginConfig:{}, currentSettings:{}, t:key=>en[key] || key,
      tagPipeline:{registerRenderer(name, renderer){ this[name]=renderer; renderer.injectCss?.(); },clearProcessed(){},scheduleScan(){}} };
    const Real=window.ResizeObserver;window.__observed=0;
    window.ResizeObserver=class extends Real{observe(el){window.__observed++;return super.observe(el);}};
  }, en);
  for (const file of ['core/ui-kit.js','core/dom-observer.js','core/tag-renderer-base.js','core/tag-layout.js','tags/tag-layout-styles.js',
    'tags/tag-styles.js','tags/status-vocabulary.js','tags/statustags.js']) await page.addScriptTag({path:path.join(root,file)});
  const observed = await page.evaluate(async () => {
    const JE=JellyfinEnhanced,h=document.querySelector('.je-tag-host');
    Object.assign(JE.currentSettings,{statusTagsEnabled:true,statusTagsShowJustAdded:true,statusTagsJustAddedDays:30});
    JE.initializeStatusTags();JE.core.tagLayout.invalidateSettings();
    JE.tagPipeline.status.renderFromServerCache(h,{Type:'Movie',DateCreated:new Date().toISOString()});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    return {legacy:h.dataset.jeLegacy,chips:h.querySelectorAll('.status-tag').length,observed:window.__observed};
  });
  expect(observed.chips).toBe(1);
  expect(observed.observed).toBe(0);
});
