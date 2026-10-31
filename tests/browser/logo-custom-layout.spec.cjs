const { test, expect } = require('@playwright/test');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { brotliDecompressSync } = require('node:zlib');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced');
const fixture = path.resolve(__dirname, '../fixtures/logo-custom-layout.json');
const font = brotliDecompressSync(readFileSync(path.join(root,'Assets/PosterTags/fonts/NotoSans-Bold.ttf.br'))).toString('base64');
const scaleCss = readFileSync(path.join(root,'js/tags/tag-pipeline.js'),'utf8').match(/const scaleCss = `([\s\S]*?)`;/)[1];
test.use({ viewport:{width:800,height:600},deviceScaleFactor:1,isMobile:false });
test('Logos and Custom native metric oracle follows size, gap, Flush and Poster fields', async ({ page }, info) => {
  await page.setContent(`<style>@font-face{font-family:Oracle;src:url(data:font/ttf;base64,${font});font-weight:100 900}body{margin:0;font-family:Oracle}.cardScalable{position:relative;width:180px;height:270px;container-type:inline-size}.je-tag-host{position:absolute;inset:0}</style><div class="card"><div class="cardScalable"><div class="je-tag-host"></div></div></div>`);
  await page.evaluate(() => { window.renderers = new Map(); window.JellyfinEnhanced = {pluginConfig:{},currentSettings:{tagLayoutSettingsVersion:1,tagLayout:'corners',logoTagsEnabled:true,customTagsEnabled:true},t:k=>k,tagPipeline:{registerRenderer:(n,r)=>renderers.set(n,r),clearProcessed(){},scheduleScan(){}}}; });
  for(const f of ['core/ui-kit.js','core/tag-renderer-base.js','core/tag-layout.js','tags/tag-layout-styles.js','tags/logotags.js','tags/customtags.js','tags/tag-styles.js']) await page.addScriptTag({path:path.join(root,'js',f)});
  await page.addStyleTag({content:scaleCss});
  await page.evaluate(async()=>{JellyfinEnhanced.initializeLogoTags();JellyfinEnhanced.initializeCustomTags();await document.fonts.load('700 13px Oracle');});
  const all=[];
  for(const [scale,gap] of [['smaller','tight'],['largest','roomy']]) for(const edge of ['tight','flush']) for(const group of ['logos','custom']) {
    const row=await page.evaluate(({scale,gap,edge,group})=>{
      const JE=JellyfinEnhanced, host=document.querySelector('.je-tag-host');
      JE.core.tagLayout.clearAll(); Object.assign(JE.currentSettings,{tagScale:scale,tagGap:gap,tagEdgeSpacing:edge,tagGroupOrder:[group]});JE.core.tagLayout.invalidateSettings();
      JE.pluginConfig.CustomTagRules=[{Id:'tag:1',Label:'Plot fact'},{Id:'tag:2',Label:'Second'}];
      const entry=group==='logos'?{Logos:[{kind:'network',name:'Northwind'},{kind:'studio',name:'Studio'}]}:{CustomTags:['tag:1','tag:2']};
      renderers.get(group).renderFromServerCache(host,{Type:'Movie',...entry},'item');JE.core.tagLayout.flushFit();
      const selector=group==='logos'?'.je-logo-chip':'.custom-tag', chips=[...host.querySelectorAll(`.je-tag-slot:not([data-je-slot="hover"]) ${selector}`)];
      const first=chips[0],r=first.getBoundingClientRect(),s=getComputedStyle(first),p=first.parentElement;
      return {group,scale,gap,edge,width:r.width,height:r.height,font:parseFloat(s.fontSize),padding:s.padding,gapPx:parseFloat(getComputedStyle(p).gap),left:r.left,top:r.top,radius:s.borderRadius};
    },{scale,gap,edge,group});
    expect(row.gapPx).toBeCloseTo((group==='logos'?4:3)*(scale==='smaller'?.85:1.3)*(gap==='tight'?.75:1.5),3);
    expect(group==='logos'?row.left:row.top).toBeCloseTo(edge==='flush'?0:3,3);
    if(edge==='flush') expect(row.radius).toMatch(/^0px/);
    all.push(row);
  }
  if(process.env.JE_UPDATE_TAG_GROUP_FIXTURES==='1'&&info.project.name==='chromium') writeFileSync(fixture,JSON.stringify(all,null,2)+'\n');
  const expected=JSON.parse(readFileSync(fixture,'utf8'));expect(all).toHaveLength(expected.length);
  for(let i=0;i<all.length;i++)for(const key of ['width','height','font','gapPx'])expect(Math.abs(all[i][key]-expected[i][key]), `${i} ${key}: ${all[i][key]} vs ${expected[i][key]}`).toBeLessThanOrEqual(info.project.name==='firefox'&&key==='width'?2.1:.15);
  await page.evaluate(()=>{const JE=JellyfinEnhanced;JE.core.ui.injectCss('test-poster-style', JE.tagStyles.buildCss({preset:'poster'}));const h=document.querySelector('.je-tag-host');h.dataset.jePosterColour='1';h.style.setProperty('--je-tag-bg','rgb(10, 20, 30)');h.style.setProperty('--je-tag-border','rgb(40, 50, 60)');h.style.setProperty('--je-tag-fg','rgb(240, 230, 220)');});
  await expect(page.locator('.custom-tag').first()).toHaveCSS('background-color','rgb(10, 20, 30)');
});
