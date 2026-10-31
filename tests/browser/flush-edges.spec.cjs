const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const cases = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/flush-edges.json')));

/** Load production geometry with a fixed logical card and actual quality chips. */
async function setup(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setContent(`<style>
    .cardBox { container-type: inline-size; width:180px }
    .cardScalable { position:relative; width:180px; height:270px }
    .cardImageContainer { position:absolute; inset:0; border-radius:8px }
    .je-tag-host { position:absolute!important; inset:0 }
    .countIndicator { position:absolute; right:0; top:0; width:30px; height:30px }
    .itemProgressBar { position:absolute; bottom:0; width:100%; height:4px }
  </style><div class="card"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Fixture</div></div></div>`);
  await page.evaluate(() => { window.JellyfinEnhanced = { pluginConfig:{}, currentSettings:{qualityTagsEnabled:true,tagLayoutSettingsVersion:1,tagEdgeSpacing:'flush',tagLayout:'corners'}, t:k=>k,
    tagPipeline:{registerRenderer(name, renderer){renderer.injectCss?.();},clearProcessed(){},scheduleScan(){}} }; });
  for (const file of ['core/ui-kit.js','core/tag-renderer-base.js','core/tag-layout.js','tags/tag-layout-styles.js','tags/qualitytags.js']) await page.addScriptTag({path:path.join(root,file)});
  await page.evaluate(() => { JellyfinEnhanced.initializeQualityTags(); });
}

/** Place a controlled quality label, with real Jellyfin-style indicator wrappers. */
async function place(page, row, text = '4K') {
  return page.evaluate(async ({ row, text }) => {
    const JE=JellyfinEnhanced,L=JE.core.tagLayout,host=document.querySelector('.je-tag-host'),surface=host.parentElement;
    surface.querySelectorAll('.cardIndicators,.itemProgressBar').forEach(e=>e.remove());
    if(row.indicator){const box=document.createElement('div');box.className='cardIndicators';box.innerHTML='<div style="position:absolute;width:100%"><div class="countIndicator">2</div></div>';surface.append(box);}
    if(row.progress){const bar=document.createElement('div');bar.className='itemProgressBar';surface.append(bar);}
    JE.currentSettings.tagLayouts={corners:{groups:[{group:'quality',slot:row.slot}]}};
    const group=document.createElement('div');group.className='quality-overlay-container';group.innerHTML=`<span class="quality-overlay-label resolution">${text}</span>`;
    L.invalidateSettings();L.commitGroup(host,'quality',group);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));L.flushFit();
    const chip=host.querySelector('.quality-overlay-label'),b=chip.getBoundingClientRect(),h=host.getBoundingClientRect(),s=getComputedStyle(chip);
    const clear=c=>c==='transparent'||c==='rgba(0, 0, 0, 0)';
    return {indicatorGap:host.dataset.jeIndicatorGap,slot:chip.closest('.je-tag-slot').outerHTML.slice(0,200),edges:(clear(s.borderLeftColor)?1:0)|(clear(s.borderTopColor)?2:0)|(clear(s.borderRightColor)?4:0)|(clear(s.borderBottomColor)?8:0),
      top:b.top-h.top,bottom:h.bottom-b.bottom,left:b.left-h.left,right:h.right-b.right,hidden:chip.hasAttribute('data-je-overflow'),clip:s.clipPath,
      tl:s.borderTopLeftRadius,tr:s.borderTopRightRadius,bl:s.borderBottomLeftRadius,br:s.borderBottomRightRadius};
  }, {row,text});
}

test('Flush shares edge masks with native at all nine anchors, indicators and progress bars', async ({ page }) => {
  test.setTimeout(45000);
  await setup(page);
  for(const row of cases){
    const result=await place(page,row);
    expect(result.edges,JSON.stringify({row,result})).toBe(row.edges);
    if(row.slot==='tc')expect(result.top).toBeCloseTo(0,2);
    if(row.slot==='bc')expect(result.bottom).toBeCloseTo(row.progress,2);
    if(row.edges&2){expect(result.tl).toBe('0px');expect(result.tr).toBe('0px');}
    if(row.edges&8){expect(result.bl).toBe('0px');expect(result.br).toBe('0px');}
  }
});

test('Flush top centre moves below indicators only when its first chip cannot fit the gap', async ({ page }) => {
  await setup(page);
  const row={slot:'tc',indicator:true,progress:0};
  expect((await place(page,row)).top).toBe(0);
  const wide=await place(page,row,'WWWWWWWWWW');
  expect(wide.top).toBeGreaterThan(30);
  expect(wide.hidden).toBe(false);
  expect(wide.edges&2).toBe(0);
});

test('Flush mixed-height centre rows align chips on the touching edge', async ({page}) => {
  await setup(page);
  for (const slot of ['tc', 'bc']) {
    await place(page, {slot,indicator:false,progress:0});
    const rows = await page.evaluate(async slot => {
      const JE=JellyfinEnhanced,host=document.querySelector('.je-tag-host');
      const group=document.createElement('div');group.className='status-overlay-container';
      group.innerHTML='<span class="status-tag" style="display:block;width:40px;height:32px">Added</span>';
      JE.currentSettings.tagLayouts.corners.groups.push({group:'status',slot});JE.core.tagLayout.invalidateSettings();
      JE.core.tagLayout.commitGroup(host,'status',group);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));JE.core.tagLayout.flushFit();
      const h=host.getBoundingClientRect();
      return [...host.querySelectorAll('.quality-overlay-label,.status-tag')].map(c=>{const r=c.getBoundingClientRect();return {top:r.top-h.top,bottom:h.bottom-r.bottom};});
    },slot);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(slot==='tc'?row.top:row.bottom).toBeCloseTo(0,2);
  }
});


test('scoped presets, Poster, group and label colours keep only inward Flush borders', async ({ page }) => {
  test.setTimeout(60000);
  await setup(page);
  await page.addScriptTag({ path: path.join(root, 'tags/tag-styles.js') });
  await page.evaluate(() => {
    const card = document.querySelector('.card'); card.id = 'jeTaPreviewBody'; card.setAttribute('data-je-tag-styles-scope', '');
    card.setAttribute('data-je-poster-colour', ''); card.style.setProperty('--je-tag-border', 'rgb(0, 255, 0)');
  });
  for (const model of [
    { quality: { '*': { border: 'rgba(255, 0, 0, 1)' } } }, // resolved bordered preset / group
    { preset: 'poster' },
    { preset: 'poster', quality: { '*': { border: 'rgba(255, 0, 0, 1)' } } },
    { quality: { '4K': { border: 'rgba(255, 0, 0, 1)' } } },
  ]) for (const order of ['before', 'after']) {
    await page.evaluate(({ model, order }) => {
      document.getElementById('scoped-colours')?.remove();
      const sheet = document.createElement('style'); sheet.id = 'scoped-colours';
      sheet.textContent = JellyfinEnhanced.tagStyles.buildCss(model, '#jeTaPreviewBody');
      if (order === 'before') document.head.prepend(sheet); else document.head.append(sheet);
    }, {model,order});
    for (const slot of ['tc', 'bc', 'tl', 'tr', 'bl', 'br']) {
      const row = {slot,indicator:false,progress:0,edges: {tc:2,bc:8,tl:3,tr:6,bl:9,br:12}[slot]};
      const result = await place(page, row);
      expect(result.edges, JSON.stringify({model,order,slot,result})).toBe(row.edges);
    }
  }
});
