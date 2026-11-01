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

/** Compare an intrinsic production chip with the same chip after a real fit pass. */
async function chipGeometry(page, kind, linked, styled, actual = false) {
  return page.evaluate(async ({kind,linked,styled,actual})=>{
    const JE=JellyfinEnhanced,L=JE.core.tagLayout,h=document.querySelector('.je-tag-host');
    const image=document.querySelector('.cardImageContainer');if(linked)image.setAttribute('href','#/details?id=0123456789abcdef0123456789abcdef');else image.removeAttribute('href');
    const group=kind==='logoText'||kind==='logoImage'?'logos':kind==='languageFlag'?'language':kind;
    if(actual){const width=kind==='rating'||kind==='status'?80:kind==='language'?40:kind==='quality'?80:180;for(const c of document.querySelectorAll('.cardBox,.cardScalable'))c.style.width=width+'px';}
    Object.assign(JE.currentSettings,{statusTagsEnabled:true,statusTagsJustAddedDays:30,languageTagsShowSubtitles:true,languageTagsStyle:'codes',showResolutionTag:false,showDynamicRangeTag:true,
      tagLayouts:{corners:{groups:[{group,slot:'ml'}]}}});L.invalidateSettings();
    document.getElementById('geometry-colours')?.remove();
    if(styled){const style=document.createElement('style');style.id='geometry-colours';style.textContent=JE.tagStyles.buildCss({preset:'outline'});document.head.append(style);}
    const render=(name,data)=>JE.tagPipeline[name].renderFromServerCache(h,data,'0123456789abcdef0123456789abcdef');
    if(kind==='custom'){
      const w=document.createElement('div');w.className='custom-overlay-container';w.append(JE.customTags.buildChip({id:'test',icon:'theaters',label:'A long custom label here'}));L.commitGroup(h,group,w);
    }else if(kind==='rating'){
      const w=document.createElement('div');w.className='rating-overlay-container';w.append(JE.ratingSources.chip({id:'imdb',value:8.1,text:'8.1'}));L.commitGroup(h,group,w);
    }else if(kind==='awards') render('awards',{Awards:{CertifiedFresh:true}});
    else if(kind==='genre') render('genre',{Genres:['Science Fiction']});
    else if(kind==='status') render('status',{Type:'Movie',DateCreated:new Date().toISOString()});
    else if(kind==='quality') render('quality',{StreamData:{Streams:[{Type:'Video',Width:3840,Height:2160,VideoRangeType:'DOVIWithHDR10'}]}});
    else if(kind==='language'||kind==='languageFlag') {
      if(kind==='languageFlag')JE.currentSettings.languageTagsStyle='flags';
      L.commitGroup(h,group,JE.core.languageTags.buildGroup({subtitles:[{code:'en',name:'English',sdh:true}]},3,()=> 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"/>')));
    }
    else{
      const w=document.createElement('div');w.className='logo-overlay-container';
      const src=kind==='logoImage'?'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="18"/>'):undefined;
      w.append(JE.logoTags.buildChip({kind:'studio',name:'WarnerBrosPictures',logo:null},src));L.commitGroup(h,group,w);
    }
    await document.fonts.load('16px "JE Material Symbols Outlined"','theaters');await document.fonts.ready;
    await Promise.all([...h.querySelectorAll('img')].map(i=>i.decode().catch(()=>{})));
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));L.flushFit();
    const selector={custom:'.custom-tag',rating:'.rating-tag',awards:'.awards-tag',genre:'.genre-tag',status:'.status-tag',quality:'.quality-overlay-label',language:'.language-chip',languageFlag:'.language-chip',logoText:'.je-logo-chip',logoImage:'.je-logo-chip'}[kind];
    let chip=h.querySelector(selector);const fit=chip.closest('a')||chip;
    // Capture the intrinsic box measured by measureFit, before its writes.
    fit.removeAttribute('data-je-fit-width');fit.style.removeProperty('--je-chip-fit-width');
    const geometry=()=>{
      chip=h.querySelector(selector);const b=chip.getBoundingClientRect(),s=getComputedStyle(chip),i=chip.querySelector('.custom-tag-icon,.je-rating-source-logo,.awards-tag-logo,.je-msym-outlined,.language-flag,.language-cc,.je-logo-img'),ib=i?.getBoundingClientRect(),ring=getComputedStyle(chip,'::after');
      return {height:b.height,display:s.display,width:b.width,icon:ib?{width:ib.width,height:ib.height,centre:ib.y+ib.height/2-b.y}:null,
        clip:s.clipPath,left:s.borderLeftColor,right:s.borderRightColor,tl:s.borderTopLeftRadius,tr:s.borderTopRightRadius,ringLeft:ring.borderLeftWidth,ringRight:ring.borderRightWidth};
    };
    const before=geometry();
    // Re-run the real planner where it fits, plus exercise the 88px CSS
    // constraint on naturally small icon/code chips without enlarging them.
    if(actual){
      const opposite=group==='status'?'awards':'status';
      JE.currentSettings.tagLayouts.corners.groups.push({group:opposite,slot:'mr'});L.invalidateSettings();L.refreshPresentation(h);
      render(opposite,opposite==='status'?{Type:'Movie',DateCreated:new Date().toISOString()}:{Awards:{CertifiedFresh:true}});
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));L.flushFit();
    }else{fit.setAttribute('data-je-fit-width','');fit.style.setProperty('--je-chip-fit-width',kind==='rating'?'38px':'88px');}
    const after=geometry();
    return {before,after,hidden:chip.hasAttribute('data-je-overflow'),more:[...h.querySelectorAll('.je-tag-more:not([data-je-overflow])')].map(chip=>({text:chip.textContent,title:chip.title})),html:chip.outerHTML+JSON.stringify([...chip.querySelectorAll('.je-tag-fit-text,.custom-tag-text,.rating-text,span:last-child')].map(t=>({text:t.textContent,w:t.clientWidth,sw:t.scrollWidth,ellipsis:getComputedStyle(t).textOverflow,min:getComputedStyle(t).minWidth}))),constrained:!!chip.closest('[data-je-fit-width]'),textEllipsis:[...chip.querySelectorAll('.je-tag-fit-text,.custom-tag-text,.rating-text,.awards-tag > span:last-child')].some(t=>getComputedStyle(t).textOverflow==='ellipsis'&&t.scrollWidth>t.clientWidth)};
  },{kind,linked,styled,actual});
}

for(const kind of ['custom','status','quality','genre','language','languageFlag','awards','logoText','logoImage']){
  test(`production ${kind} keeps its flex height, icon alignment and Flush paint when constrained`,async ({page})=>{
    await setup(page);
    for(const file of ['core/media-language.js','tags/languagetags.js','tags/customtags.js','tags/rating-sources.js','tags/ratingtags.js','tags/qualitytags.js','tags/genretags.js','tags/logotags.js'])await page.addScriptTag({path:path.join(root,file)});
    await page.evaluate(()=>{const JE=JellyfinEnhanced;JE.initializeLanguageTags();JE.initializeCustomTags();JE.initializeRatingTags();JE.initializeQualityTags();JE.initializeGenreTags();JE.initializeLogoTags();});
    for(const linked of kind==='language'||kind==='languageFlag'||kind==='awards'?[false,true]:[true]) for(const styled of [false,true]){
      // Each sample starts from fresh production markup and stylesheet state.
      const r=await chipGeometry(page,kind,linked,styled);
      expect(r.after.height,r.html).toBeCloseTo(r.before.height,3);expect(r.after.display).toBe(r.before.display);
      expect(r.after.icon,r.html).toEqual(r.before.icon);
      for(const key of ['clip','left','right','tl','tr','ringLeft','ringRight'])expect(r.after[key],key).toBe(r.before[key]);
      await page.evaluate(()=>{const L=JellyfinEnhanced.core.tagLayout,h=document.querySelector('.je-tag-host');for(const g of ['custom','rating','status','quality','genre','language','awards','logos'])L.removeGroup(h,g);});
      if(!['genre','languageFlag','logoImage'].includes(kind)){
        const fitted=await chipGeometry(page,kind,linked,styled,true);
        expect(fitted.constrained,fitted.html).toBe(true);expect(fitted.after.height,fitted.html).toBeCloseTo(fitted.before.height,3);
        expect(fitted.after.icon).toEqual(fitted.before.icon);expect(fitted.textEllipsis,fitted.html).toBe(true);
      }
      await page.evaluate(()=>{const L=JellyfinEnhanced.core.tagLayout,h=document.querySelector('.je-tag-host');for(const g of ['custom','rating','status','quality','genre','language','awards','logos'])L.removeGroup(h,g);});
    }
  });
}

const textLogoCases = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/first-chip-text-fit.json')));
test('text-logo side fixtures keep web/native font size and letter spacing while ellipsizing',async ({page})=>{
  await setup(page);
  await page.addScriptTag({path:path.join(root,'tags/logotags.js')});
  const noto=require('node:zlib').brotliDecompressSync(fs.readFileSync(path.resolve(root,'../Assets/PosterTags/fonts/NotoSans-Bold.ttf.br'))).toString('base64');
  await page.addStyleTag({content:`@font-face{font-family:FitNoto;src:url(data:font/ttf;base64,${noto});font-weight:700}body{font-family:FitNoto,sans-serif}`});
  await page.evaluate(()=>JellyfinEnhanced.initializeLogoTags());
  for(const row of textLogoCases){
    const r=await page.evaluate(async row=>{
      const JE=JellyfinEnhanced,L=JE.core.tagLayout,h=document.querySelector('.je-tag-host');
      for(const g of ['logos','status'])L.removeGroup(h,g);
      Object.assign(JE.currentSettings,{tagScale:row.scale,tagGap:'tight',tagLayouts:{corners:{groups:[{group:'logos',slot:row.slot},{group:'status',slot:row.slot==='ml'?'mr':'ml'}]}}});L.invalidateSettings();
      const w=document.createElement('div');w.className='logo-overlay-container';w.append(JE.logoTags.buildChip({kind:'studio',name:row.name,logo:null}));L.commitGroup(h,'logos',w);
      JE.tagPipeline.status.renderFromServerCache(h,{Type:'Movie',DateCreated:new Date().toISOString()});
      await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));L.flushFit();
      const c=h.querySelector('.je-logo-chip'),s=getComputedStyle(c),t=c.querySelector('.je-tag-fit-text'),ts=getComputedStyle(t||c);
      return {fontSize:parseFloat(s.fontSize),spacing:parseFloat(s.letterSpacing),textFontSize:parseFloat(ts.fontSize),textSpacing:parseFloat(ts.letterSpacing),ellipsis:ts.textOverflow,overflow:t?t.scrollWidth>t.clientWidth:false,html:h.outerHTML};
    },row);
    expect(r.fontSize).toBeCloseTo(row.fontSize,3);expect(r.textFontSize).toBeCloseTo(row.fontSize,3);
    expect(r.spacing).toBeCloseTo(row.letterSpacing,3);expect(r.textSpacing).toBeCloseTo(row.letterSpacing,3);
    expect(r.ellipsis,r.html).toBe('ellipsis');expect(r.overflow,r.html).toBe(true);
  }
});


test('production rating keeps its full value in overflow when a side budget cannot fit it', async ({page}) => {
  await setup(page);
  for (const file of ['tags/rating-sources.js','tags/ratingtags.js']) await page.addScriptTag({path:path.join(root,file)});
  await page.evaluate(()=>JellyfinEnhanced.initializeRatingTags());
  for (const styled of [false,true]) {
    const fitted = await chipGeometry(page,'rating',true,styled,true);
    expect(fitted.hidden,fitted.html).toBe(true);
    expect(fitted.constrained,fitted.html).toBe(false);
    expect(fitted.textEllipsis,fitted.html).toBe(false);
    expect(fitted.more).toContainEqual({text:'+1',title:'IMDb: 8.1'});
    expect(fitted.html).toContain('8.1');
    await page.evaluate(()=>{const L=JellyfinEnhanced.core.tagLayout,h=document.querySelector('.je-tag-host');for(const g of ['rating','status'])L.removeGroup(h,g);});
  }
});
