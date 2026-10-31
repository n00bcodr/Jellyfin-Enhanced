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

// More chips sit directly in the slot; they have no group wrapper.
test('Flush overflow-only and mixed centre rows treat +N as a visible edge chip', async ({ page }) => {
  await setup(page);
  for (const slot of ['tc', 'bc']) for (const mixed of [false, true]) for (const progress of [0, 4]) {
    await place(page, {slot,progress,indicator:false});
    const result = await page.evaluate(async ({slot,mixed}) => {
      const L=JellyfinEnhanced.core.tagLayout, host=document.querySelector('.je-tag-host');
      const group=document.createElement('div');group.className='quality-overlay-container';
      group.innerHTML=(mixed?'<span class="quality-overlay-label">4K</span>':'')+'<span class="quality-overlay-label">'+ 'W'.repeat(100)+'</span>';
      L.commitGroup(host,'quality',group);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));L.flushFit();
      const more=host.querySelector('.je-tag-more'),s=getComputedStyle(more),b=more.getBoundingClientRect(),h=host.getBoundingClientRect();
      return {text:more.textContent,hidden:more.hasAttribute('data-je-overflow'),top:b.top-h.top,bottom:h.bottom-b.bottom,
        border:slot==='tc'?s.borderTopColor:s.borderBottomColor, radius:slot==='tc'?s.borderTopLeftRadius:s.borderBottomLeftRadius,clip:s.clipPath};
    },{slot,mixed});
    expect(result.text).toBe('+1');expect(result.hidden).toBe(false);
    expect(result.border).toBe('rgba(0, 0, 0, 0)');expect(result.radius).toBe('0px');expect(result.clip).not.toBe('none');
    expect(slot==='tc'?result.top:result.bottom).toBeCloseTo(slot==='tc'?0:progress,2);
  }
});

test('Flush direct overflow chips at corners keep the same side treatment as group chips', async ({page}) => {
  await setup(page);
  for(const slot of ['tl','tr','bl','br']) for(const mixed of [false,true]) {
    await place(page,{slot,progress:0,indicator:false});
    const result=await page.evaluate(({slot,mixed})=>{
      const container=document.querySelector(`[data-je-slot="${slot}"]`);
      if(!mixed)container.replaceChildren();
      const more=document.createElement('span');more.className='je-tag-more';more.textContent='+1';container.append(more);
      const s=getComputedStyle(more);
      return {side:slot.endsWith('l')?s.borderLeftColor:s.borderRightColor,
        edge:slot.startsWith('t')?s.borderTopColor:s.borderBottomColor,clip:s.clipPath};
    },{slot,mixed});
    expect(result.side).toBe('rgba(0, 0, 0, 0)');expect(result.clip).not.toBe('none');
    expect(result.edge==='rgba(0, 0, 0, 0)').toBe(!mixed);
  }
});

test('Flush Rating and Awards keep inner rings at centre and remove only touching sides', async ({page}) => {
  test.setTimeout(45000);
  const { spawnSync } = require('node:child_process');
  await setup(page);
  await page.addScriptTag({path:path.join(root,'tags/tag-styles.js')});
  await page.addStyleTag({content:'.rating-tag,.awards-tag{display:block;box-sizing:border-box;width:80px;height:24px;position:relative;border-radius:4px;background:#000}'});
  for(const scoped of [false,true]) for(const group of ['rating','awards']) for(const slot of ['tl','tc','tr','ml','c','mr','bl','bc','br']) {
    const rect=await page.evaluate(async ({scoped,group,slot})=>{
      const JE=JellyfinEnhanced,L=JE.core.tagLayout,host=document.querySelector('.je-tag-host');
      L.clearCard(host);const card=document.querySelector('.card');card.id='jeTaPreviewBody';
      if(scoped)card.setAttribute('data-je-tag-styles-scope','');else card.removeAttribute('data-je-tag-styles-scope');
      document.getElementById('ring-colours')?.remove();
      const sheet=document.createElement('style');sheet.id='ring-colours';
      const c={border:'rgba(255, 0, 0, 1)',background:'rgba(0, 0, 0, 1)'};
      sheet.textContent=JE.tagStyles.buildCss(group==='rating'?{rating:{community:c}}:{awards:{oscar:c}},scoped?'#jeTaPreviewBody':undefined);document.head.append(sheet);
      JE.currentSettings.tagLayouts={corners:{groups:[{group,slot}]}};L.invalidateSettings();
      const wrapper=document.createElement('div');wrapper.className=group+'-overlay-container';
      wrapper.innerHTML=group==='rating'?'<span class="rating-tag rating-tag-tmdb"></span>':'<span class="awards-tag" data-je-award="oscar"></span>';
      const nextHost=document.querySelector('.je-tag-host');L.commitGroup(nextHost||document.querySelector('.cardImageContainer'),group,wrapper);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));L.flushFit();
      const chip=document.querySelector('.'+(group==='rating'?'rating-tag':'awards-tag')),r=chip.getBoundingClientRect();
      return {x:r.x,y:r.y,w:r.width,h:r.height,offset:getComputedStyle(chip).outlineOffset};
    },{scoped,group,slot});
    expect(rect.offset).toBe('-1px');
    const pixels=spawnSync('python3',['-c',`import sys,json
from PIL import Image
im=Image.open(sys.stdin.buffer).convert('RGB');r=json.loads(sys.argv[1]);x,y,w,h=[r[k] for k in ['x','y','w','h']]
points=[(x,y+h/2),(x+w/2,y),(x+w-1,y+h/2),(x+w/2,y+h-1)]
print(json.dumps([im.getpixel((round(a),round(b)))[0]>200 and im.getpixel((round(a),round(b)))[1]<60 for a,b in points]))`,JSON.stringify(rect)],{input:await page.screenshot({scale: 'css'}),encoding:'utf8'});
    expect(pixels.status,pixels.stderr).toBe(0);
    const edges={tl:3,tc:2,tr:6,ml:1,c:0,mr:4,bl:9,bc:8,br:12}[slot];
    expect(JSON.parse(pixels.stdout),JSON.stringify({scoped,group,slot,rect})).toEqual([1,2,4,8].map(side=>!(edges&side)));
  }
});
