const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const en = JSON.parse(fs.readFileSync(path.join(root, 'locales/en.json')));

/** Use the real renderers, a linked Jellyfin poster and the bundled icon fonts. */
async function setup(page) {
  await page.goto('/');
  await page.setContent(`<style>
    @font-face { font-family:'JE Material Symbols Outlined'; src:url('/Jellyfin.Plugin.JellyfinEnhanced/js/fonts/materialsymbolsoutlined-subset.woff2') }
    .cardBox { container-type:inline-size; width:180px }
    .cardScalable { position:relative; width:180px; height:270px }
    .cardImageContainer { position:absolute; inset:0; border-radius:8px }
    .je-tag-host { position:absolute!important; inset:0 }
  </style><div class="card" data-type="Movie"><div class="cardBox"><div class="cardScalable"><a class="cardImageContainer" href="#/details?id=0123456789abcdef0123456789abcdef"></a><div class="je-tag-host"></div></div><div class="cardText">Fixture</div></div></div>`);
  await page.evaluate(en => {
    window.JellyfinEnhanced = { pluginConfig:{}, currentSettings:{tagLayoutSettingsVersion:1,tagLayout:'corners',tagEdgeSpacing:'flush'},
      t:key=>en[key] || key, tagPipeline:{registerRenderer(name, renderer){ this[name]=renderer; renderer.injectCss?.(); },clearProcessed(){},scheduleScan(){}} };
  }, en);
  for (const file of ['core/ui-kit.js','core/tag-renderer-base.js','core/tag-layout.js','tags/tag-layout-styles.js',
    'tags/tag-styles.js','tags/status-vocabulary.js','tags/statustags.js','tags/awardstags.js']) await page.addScriptTag({path:path.join(root,file)});
  await page.evaluate(() => {
    JellyfinEnhanced.initializeStatusTags(); JellyfinEnhanced.initializeAwardsTags();
  });
}

/** Render production Awards opposite production Status; repeat fitting to catch feedback. */
async function awards(page, styled) {
  return page.evaluate(async styled => {
    const JE=JellyfinEnhanced,L=JE.core.tagLayout,h=document.querySelector('.je-tag-host');
    Object.assign(JE.currentSettings,{statusTagsEnabled:true,statusTagsShowJustAdded:true,statusTagsJustAddedDays:30,
      tagLayouts:{corners:{groups:[{group:'awards',slot:'ml'},{group:'status',slot:'mr'}]}}});
    L.invalidateSettings();
    document.getElementById('fit-colours')?.remove();
    if(styled){const s=document.createElement('style');s.id='fit-colours';s.textContent=JE.tagStyles.buildCss({awards:{certifiedFresh:{border:'rgba(255, 0, 0, 1)'}}});document.head.append(s);}
    JE.tagPipeline.awards.renderFromServerCache(h,{Awards:{CertifiedFresh:true}});
    JE.tagPipeline.status.renderFromServerCache(h,{Type:'Movie',DateCreated:new Date().toISOString()});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const results=[];
    for(let i=0;i<3;i++){
      L.refreshPresentation(h);L.flushFit();
      const c=h.querySelector('.awards-tag'),a=c.parentElement,t=c.lastElementChild,s=getComputedStyle(c),ts=getComputedStyle(t),ring=getComputedStyle(c,'::after'),b=c.getBoundingClientRect(),ab=a.getBoundingClientRect(),op=h.querySelector('.status-tag').getBoundingClientRect();
      results.push({width:b.width,wrapperWidth:ab.width,budget:parseFloat(a.style.getPropertyValue('--je-chip-fit-width')),
        href:a.getAttribute('href'),linked:a.matches('.awards-link'),ellipsis:ts.textOverflow,textOverflow:t.scrollWidth>t.clientWidth,
        left:s.borderLeftColor,right:s.borderRightColor,tl:s.borderTopLeftRadius,tr:s.borderTopRightRadius,
        clip:s.clipPath,ringLeft:ring.borderLeftWidth,ringRight:ring.borderRightWidth,ringColor:ring.borderRightColor,
        overlap:b.right-op.left,hidden:a.hasAttribute('data-je-overflow')});
    }
    return results;
  },styled);
}

test('linked production Awards constrain the chip and ellipsize inside its Flush border and ring',async ({page})=>{
  await setup(page);
  for(const styled of [false,true]){
    const rows=await awards(page,styled);
    for(const r of rows){
      expect(r.linked).toBe(true);expect(r.href).toContain('#/details?id=');expect(r.hidden).toBe(false);
      expect(r.budget).toBe(88);expect(r.width).toBeCloseTo(r.budget,1);expect(r.wrapperWidth).toBeCloseTo(r.width,1);
      expect(r.ellipsis).toBe('ellipsis');expect(r.textOverflow).toBe(true);expect(r.overlap).toBeLessThanOrEqual(-4);
      expect(r.tl).toBe('0px');expect(parseFloat(r.tr)).toBeGreaterThan(0);expect(r.clip).not.toBe('none');
      if(styled){expect(r.ringLeft).toBe('0px');expect(r.ringRight).toBe('1px');expect(r.ringColor).toBe('rgb(255, 0, 0)');}
    }
    expect(rows[2]).toEqual(rows[0]);
  }
});

test('linked production Language code ellipsizes inside the constrained chip',async ({page})=>{
  await setup(page);
  for(const file of ['core/media-language.js','tags/languagetags.js']) await page.addScriptTag({path:path.join(root,file)});
  const r=await page.evaluate(async()=>{
    const JE=JellyfinEnhanced,L=JE.core.tagLayout,h=document.querySelector('.je-tag-host');JE.initializeLanguageTags();
    Object.assign(JE.currentSettings,{languageTagsStyle:'codes',languageTagsShowAudio:true,
      tagLayouts:{corners:{groups:[{group:'language',slot:'ml'},{group:'status',slot:'mr'}]}}});L.invalidateSettings();
    L.commitGroup(h,'language',JE.core.languageTags.buildGroup([{code:'zh-Hant-TW',name:'Chinese'}]));
    JE.tagPipeline.status.renderFromServerCache(h,{Type:'Movie',DateCreated:new Date().toISOString()});
    // Narrow the card until the production regional language code needs fitting.
    document.querySelector('.cardBox').style.width='40px';document.querySelector('.cardScalable').style.width='40px';
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));L.flushFit();
    const c=h.querySelector('.language-chip'),a=c.parentElement,t=c.querySelector('.je-tag-fit-text');
    return {linked:a.matches('.language-link'),width:c.getBoundingClientRect().width,budget:parseFloat(a.style.getPropertyValue('--je-chip-fit-width')),
      ellipsis:t?getComputedStyle(t).textOverflow:null,overflow:t?t.scrollWidth>t.clientWidth:false};
  });
  expect(r.linked).toBe(true);expect(r.width).toBeLessThanOrEqual(r.budget+.02);expect(r.ellipsis).toBe('ellipsis');expect(r.overflow).toBe(true);
});
